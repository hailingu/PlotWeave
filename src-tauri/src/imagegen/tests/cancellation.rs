//! The #630 response distinguishes a matched active flag without dropping pre-cancellation.
use super::*;

/// Serialize the same registry result returned directly by the command.
#[test]
fn cancel_response_distinguishes_unknown_active_and_finished_jobs() {
    let registry = ImageJobRegistry::new();
    for id in ["", "job", "job"] {
        assert_eq!(
            serde_json::to_value(registry.cancel(id)).expect("serializable cancel response"),
            json!({ "cancelled": false })
        );
    }
    let job = registry.register("job");
    assert!(
        job.is_cancelled(),
        "the false response still recorded pre-cancellation"
    );
    assert!(!tombstones_of(&registry).contains(&"job".into()));
    for _ in 0..2 {
        assert_eq!(
            serde_json::to_value(registry.cancel("job")).expect("active response"),
            json!({ "cancelled": true })
        );
        assert!(job.is_cancelled());
    }
    drop(job);
    assert_eq!(
        serde_json::to_value(registry.cancel("job")).expect("finished response"),
        json!({ "cancelled": false })
    );
    let reused = registry.register("job");
    assert!(
        reused.is_cancelled(),
        "late cancel remains a one-use tombstone"
    );
}

/// A recovered lock reports a hit only after the live cancellation flag changes.
#[test]
fn cancel_response_after_poison_reflects_the_recovered_registry() {
    let registry = ImageJobRegistry::new();
    let job = registry.register("active");
    let poisoned = std::panic::catch_unwind(|| {
        let _guard = registry.state.lock().expect("initially healthy mutex");
        panic!("test-only registry poison");
    });
    assert!(poisoned.is_err());
    assert!(registry.state.is_poisoned());
    assert_eq!(
        serde_json::to_value(registry.cancel("active")).expect("recovered response"),
        json!({ "cancelled": true })
    );
    assert!(job.is_cancelled());
    assert_eq!(
        serde_json::to_value(registry.cancel("unknown")).expect("unknown response"),
        json!({ "cancelled": false })
    );
    let precancelled = registry.register("unknown");
    assert!(precancelled.is_cancelled());
}
