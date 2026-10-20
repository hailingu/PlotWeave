//! Owned HTTPS server with a synthetic certificate; no trust-store, proxy or network configuration changes.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};

/// Bounded child and reader ownership also covers TLS rejection and partially consumed bodies.
pub(super) struct TlsFixture {
    url: String,
    pub(super) certificate: reqwest::Certificate,
    child: Child,
    reader: Option<std::thread::JoinHandle<()>>,
    _root: CertificateFiles,
}

/// Python uses only its standard TLS/socket libraries and binds one ephemeral IPv4 loopback port.
const SERVER: &str = r#"
import base64,json,socket,ssl,sys,time
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(sys.argv[1],sys.argv[2])
server_names={}
ctx.set_servername_callback(lambda sock,name,_: server_names.update({id(sock):name}))
server=socket.socket()
server.bind(('127.0.0.1',0))
server.listen(8)
server.settimeout(5)
print(json.dumps(str(server.getsockname()[1])),flush=True)
responses=json.loads(sys.stdin.readline())
for encoded,stall in responses:
    raw,_=server.accept()
    raw.settimeout(5)
    try:
        with ctx.wrap_socket(raw,server_side=True) as conn:
            head=b''
            while b'\r\n\r\n' not in head:
                chunk=conn.recv(1024)
                if not chunk: raise RuntimeError('incomplete request')
                head+=chunk
                if len(head)>65536: raise RuntimeError('header cap')
            print(json.dumps(head.split(b'\r\n\r\n')[0].decode('latin1')+'\r\nFixture-SNI: '+str(server_names.pop(id(conn),None))),flush=True)
            conn.sendall(base64.b64decode(encoded))
            if stall: time.sleep(stall)
    except (ssl.SSLError,ConnectionError,BrokenPipeError):
        raw.close()
server.close()
"#;

impl TlsFixture {
    /// The startup receipt is timed; Drop kills/waits the child before removing only its generated directory.
    pub(super) fn new(build: impl FnOnce(&str) -> Vec<(Vec<u8>, u64)>) -> (Self, Receiver<String>) {
        let root = CertificateFiles::new();
        let certificate =
            reqwest::Certificate::from_pem(&std::fs::read(root.0.join("cert.pem")).unwrap())
                .unwrap();
        let mut child = Command::new("python3")
            .args(["-u", "-c", SERVER])
            .arg(root.0.join("cert.pem"))
            .arg(root.0.join("key.pem"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                let Ok(value) = serde_json::from_str::<String>(&line) else {
                    break;
                };
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        let mut fixture = Self {
            url: String::new(),
            certificate,
            child,
            reader: Some(reader),
            _root: root,
        };
        let port = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("bounded TLS server startup");
        fixture.url = format!("https://127.0.0.1:{port}");
        let encoded: Vec<_> = build(&fixture.url)
            .into_iter()
            .map(|(bytes, stall)| {
                (
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                    stall,
                )
            })
            .collect();
        let mut stdin = fixture.child.stdin.take().unwrap();
        writeln!(stdin, "{}", serde_json::to_string(&encoded).unwrap()).unwrap();
        (fixture, rx)
    }

    /// Positive tests trust only the generated certificate in this client; production trust is unmodified.
    pub(super) async fn fetch(&self, url: &str, deadline: Instant) -> Result<Vec<u8>, ProxyError> {
        fetch_with(
            url,
            deadline,
            allow_loopback,
            |_, _, _| async { panic!("literal fixture must not resolve DNS") },
            || reqwest::Client::builder().add_root_certificate(self.certificate.clone()),
        )
        .await
    }
}

impl std::ops::Deref for TlsFixture {
    type Target = str;
    /// Existing redirect fixtures use the generated base URL without losing child ownership.
    fn deref(&self) -> &str {
        &self.url
    }
}
impl std::fmt::Display for TlsFixture {
    /// Format only the owned loopback URL; no key or certificate data enters diagnostics.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.url)
    }
}
impl Drop for TlsFixture {
    /// Killing and waiting closes stdout, so the bounded reader can be joined before directory removal.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
    }
}

/// RAII cleanup includes a failed openssl invocation or failed server spawn.
struct CertificateFiles(PathBuf);
impl CertificateFiles {
    /// Synthetic leaf certificate is trusted only by explicitly configured test clients.
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pw-download-tls-{}", crate::store::new_id()));
        std::fs::create_dir(&root).unwrap();
        let owner = Self(root.clone());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let config = root.join("openssl.cnf");
        std::fs::write(&config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=fixture.invalid\n[ext]\nsubjectAltName=DNS:fixture.invalid,DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n").unwrap();
        let cert = root.join("cert.pem");
        let key = root.join("key.pem");
        let generated = Command::new("openssl")
            .args([
                "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1", "-config",
            ])
            .arg(config)
            .arg("-keyout")
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "synthetic certificate generation failed"
        );
        owner
    }
}
impl Drop for CertificateFiles {
    /// The only removed path is this fixture's unique temporary directory.
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
