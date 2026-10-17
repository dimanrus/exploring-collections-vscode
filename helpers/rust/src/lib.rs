//! Test harness that compiles the standalone helper module.
//!
//! The helper is shipped as `helpers/rust/exploring_collections.rs` so that users
//! can drop the single file into their own crate (`mod exploring_collections;`).
//! This crate only exists to build and test that file.

#[path = "../exploring_collections.rs"]
pub mod exploring_collections;

pub use exploring_collections::{describe, dump_json, dump_json_with_limits};
