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

    #[error("unknown storage slice")]
    InvalidSliceKey,

    #[error("stored data uses schema {found}, but this app supports up to {supported}")]
    SchemaTooNew { found: u64, supported: u64 },

    #[error("stored file is too large to load")]
    SliceTooLarge,

    #[error("stored data is corrupted: {0}")]
    Corrupt(String),

    #[error("no such Blob")]
    BlobNotFound,

    #[error("path is outside the Blob's home folder")]
    PathOutsideHome,

    #[error("no such file")]
    FileNotFound,

    #[error("file is too large")]
    FileTooLarge,

    #[error("file is not text")]
    NotText,

    #[error("the Blob's home folder is full")]
    HomeFull,

    #[error("storage error: {0}")]
    Io(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Result alias for command handlers.
pub(crate) type Result<T> = std::result::Result<T, Error>;
