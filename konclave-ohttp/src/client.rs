//! The client half: seal a request, open the response. Nothing here needs the gateway's secret.

use crate::{
    bhttp_map,
    padding::{self, REQUEST_OVERHEAD},
    ClientError, InnerRequest,
};

/// The key configuration this client seals with: ONE entry, X25519 / HKDF-SHA256 / AES-128-GCM
/// and nothing else. Where the bytes come from is the caller's business and the caller is the
/// bundle: a configuration fetched from the gateway is not a pin, it is whatever the gateway chose.
#[derive(Clone, Debug)]
pub struct ClientConfig {
    list: Vec<u8>,
    key_id: u8,
}

/// HPKE codepoints (RFC 9180) of the one suite this client speaks.
const KEM_X25519: u16 = 0x0020;
const KDF_HKDF_SHA256: u16 = 0x0001;
const AEAD_AES_128_GCM: u16 = 0x0001;

/// Length of that one entry's bytes: key id, KEM, a 32-byte X25519 key, the suite-list length and
/// one (KDF, AEAD) pair.
const ENTRY_LEN: usize = 1 + 2 + 32 + 2 + 4;

impl ClientConfig {
    /// Parse an encoded key-configuration list (application/ohttp-keys). The bytes are read here,
    /// once, by this function, and the key id comes from the very entry the request is sealed with:
    /// the list must be exactly one length-prefixed entry of exactly the shape above, nothing
    /// before it, after it or inside it that a decoder could skip. `ohttp`'s own list decoder
    /// drops entries it does not support without a word and indexes `symmetric[0]` of what is
    /// left, so neither a dropped entry nor an empty suite list may reach it.
    pub fn parse(list: &[u8]) -> Result<Self, ClientError> {
        let bad = || ClientError::BadConfig;
        let (len, entry) = list.split_first_chunk::<2>().ok_or_else(bad)?;
        if usize::from(u16::from_be_bytes(*len)) != entry.len() || entry.len() != ENTRY_LEN {
            return Err(bad());
        }
        let u16_at = |i: usize| u16::from_be_bytes([entry[i], entry[i + 1]]);
        if u16_at(1) != KEM_X25519
            || u16_at(35) != 4
            || u16_at(37) != KDF_HKDF_SHA256
            || u16_at(39) != AEAD_AES_128_GCM
        {
            return Err(bad());
        }
        // The crate must agree that this is one usable entry, and must be able to build a request
        // from it. Both are known to hold for the shape above; asking costs nothing and keeps a
        // future change of the crate from turning into a panic in a browser.
        let configs = ohttp::KeyConfig::decode_list(list).map_err(|_| bad())?;
        if configs.len() != 1 {
            return Err(bad());
        }
        ohttp::ClientRequest::from_encoded_config_list(list).map_err(|_| bad())?;
        Ok(Self {
            list: list.to_vec(),
            key_id: entry[0],
        })
    }

    #[must_use]
    pub fn key_id(&self) -> u8 {
        self.key_id
    }

    /// The exact bytes this configuration was parsed from: what the bundle pins.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.list
    }
}

/// Held between sealing and opening. Single use.
pub struct ClientCtx(ohttp::ClientResponse);

/// Seal a request: BHTTP, padded so the wire size is a bucket, then HPKE.
pub fn seal_request(
    config: &ClientConfig,
    req: InnerRequest,
) -> Result<(Vec<u8>, ClientCtx), ClientError> {
    let mut plain = bhttp_map::encode_request(&req).map_err(ClientError::BadRequest)?;
    let bucket = padding::request_bucket(plain.len() + REQUEST_OVERHEAD)
        .ok_or(ClientError::BadRequest("too large"))?;
    padding::pad_to(&mut plain, REQUEST_OVERHEAD, bucket);
    let client = ohttp::ClientRequest::from_encoded_config_list(&config.list)
        .map_err(|_| ClientError::BadConfig)?;
    let (wire, resp) = client
        .encapsulate(&plain)
        .map_err(|_| ClientError::BadRequest("seal"))?;
    debug_assert_eq!(wire.len(), bucket);
    Ok((wire, ClientCtx(resp)))
}

/// Open a response. The status, content type and body are produced only after the AEAD tag
/// verifies and the whole message parses; any failure returns an error and no field.
pub fn open_response(ctx: ClientCtx, bytes: &[u8]) -> Result<(u16, String, Vec<u8>), ClientError> {
    if !padding::is_response_bucket(bytes.len()) {
        return Err(ClientError::BadResponse("not a padded size"));
    }
    let plain = ctx
        .0
        .decapsulate(bytes)
        .map_err(|_| ClientError::NotAuthentic)?;
    bhttp_map::decode_response(&plain).map_err(ClientError::BadResponse)
}
