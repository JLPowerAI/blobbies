use serde::{Serialize, Serializer};

/// Every error that can cross the IPC boundary.
///
/// Commands return this instead of `String` so the frontend receives a stable,
/// matchable shape, and so internal details never leak into the webview by
/// accident: only the variants declared here are ever serialized.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("input must not be empty")]
    EmptyInput,

    #[error("input must be at most {max} characters")]
    InputTooLong { max: usize },
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Result alias for command handlers.
pub(crate) type Result<T> = std::result::Result<T, Error>;
