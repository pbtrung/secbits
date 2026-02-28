use std::io::{Cursor, Read};

use crate::Result;
use crate::error::AppError;

pub fn compress(input: &[u8]) -> Result<Vec<u8>> {
    let mut compressed = Vec::new();
    let mut reader = brotli::CompressorReader::new(Cursor::new(input), 4096, 5, 22);

    reader
        .read_to_end(&mut compressed)
        .map_err(|err| AppError::CompressionFailed(err.to_string()))?;

    Ok(compressed)
}

pub fn decompress(input: &[u8]) -> Result<Vec<u8>> {
    let mut decompressed = Vec::new();
    let mut reader = brotli::Decompressor::new(Cursor::new(input), 4096);

    reader
        .read_to_end(&mut decompressed)
        .map_err(|err| AppError::DecompressionFailed(err.to_string()))?;

    Ok(decompressed)
}

#[cfg(test)]
mod tests {
    use super::{compress, decompress};

    #[test]
    fn compression_round_trip() {
        let payload = b"hello world hello world hello world";
        let compressed = compress(payload).expect("compresses");
        let decompressed = decompress(&compressed).expect("decompresses");

        assert_eq!(decompressed, payload);
    }

    #[test]
    fn compression_round_trip_empty() {
        let compressed = compress(b"").expect("compresses");
        let decompressed = decompress(&compressed).expect("decompresses");
        assert_eq!(decompressed, b"");
    }

    #[test]
    fn repetitive_payload_compresses_well() {
        let payload = "{\"title\":\"Gmail\",\"notes\":\"hello\"}".repeat(4000);
        let compressed = compress(payload.as_bytes()).expect("compresses");

        assert!(compressed.len() < payload.len() / 2);
    }

    #[test]
    fn invalid_compressed_data_fails() {
        let result = decompress(b"not a brotli payload");
        assert!(result.is_err());
    }
}
