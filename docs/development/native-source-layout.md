# Native App Source Navigation (#947)

`native/macos/App/` is grouped by existing responsibilities. Every directory remains inside the same Xcode target and Swift module; the layout introduces no access-control, dependency, or state-ownership boundaries. `PlotWeaveNativeApp.swift` remains at the root.

| Directory | Existing responsibilities |
| --- | --- |
| `Shell/` | Application state, home and windows, host assembly, routing, quit coordination, logging, and shell layout |
| `Editor/` | Persistent Web canvas, appearance projections, toolbar, outline, inspector, node/project forms, AI, and message presentation |
| `Library/` | Asset contracts, library service, index and recovery, uploads, projections, and forms |
| `Storage/` | JSON boundaries, directory and atomic persistence, project envelope/store, sealing, and timestamp tools |
| `Providers/` | Provider settings and model services, credential binding, network policy, HTTP/DNS/download, and deadlines |
| `Media/` | Project media, opaque reads and WebKit delivery, export, and newly imported asset discard authority |

The existing `PBXFileSystemSynchronizedRootGroup` discovers nested files recursively, so no project-file source list is added. The coverage entry point retains its existing recursive App inventory. Production Swift files only move: types, access levels, imports, functions, and complete file bytes stay identical. Current capability-page relative source links follow the new locations; historical paths and immutable commit references retain their original meaning.

Run `npm run build:native` and `npm run check:size && sh scripts/test-native.sh` from the repository root. This change passed the build and 461 tests in 97 suites; coverage reported 9,830/10,779 App lines (91.20%) and all 79/79 files, retaining the report-only policy. The task evidence records all 79 before/after source hashes and 78 R100 renames. Do not add tests that assert source text, line counts, or directory layout. Final publication additionally requires the normal gates and a valid receipt for that exact HEAD.
