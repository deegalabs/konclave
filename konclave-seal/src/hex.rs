//! The one hex decoder of the hosted side.
//!
//! Hex arrives from places nobody controls: a request body, a message in a room, a file on the
//! volume. It is read in one place, which works on BYTES and accepts hex digits and nothing else: a
//! digit is `0-9`, `a-f` or `A-F` (not a sign, not a space, not any non-ASCII character) and the
//! length is even.

/// The value of one hex digit, in either case.
fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// The bytes `s` spells, or `None` when it is not an even number of ASCII hex digits. The empty
/// string is no bytes.
pub fn decode(s: &str) -> Option<Vec<u8>> {
    // Pairs of BYTES, never slices of the text. An odd length leaves a remainder, and that is refused.
    let (pairs, rest) = s.as_bytes().as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    pairs
        .iter()
        .map(|[hi, lo]| Some(nibble(*hi)? << 4 | nibble(*lo)?))
        .collect()
}

/// Exactly `N` bytes from hex, or `None`. Length is part of the check: a short value is malformed,
/// not something to pad.
pub fn decode_exact<const N: usize>(s: &str) -> Option<[u8; N]> {
    decode(s)?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_reads_either_case_and_nothing_else() {
        assert_eq!(decode(""), Some(vec![]));
        assert_eq!(decode("00ff"), Some(vec![0x00, 0xff]));
        assert_eq!(decode("00FF"), Some(vec![0x00, 0xff]));
        assert_eq!(decode("aBcD01"), Some(vec![0xab, 0xcd, 0x01]));
    }

    #[test]
    fn it_refuses_what_is_not_an_even_run_of_ascii_hex_digits() {
        for bad in [
            "a", "abc", "zz", "0x", "g0", " a", "a ", "a b ", "\n\n", "+f", "-1", "+f+f", "1_",
            "1.", "ab\0c",
        ] {
            assert_eq!(decode(bad), None, "{bad:?}");
        }
    }

    /// Text that is not ASCII, at every length and every offset.
    #[test]
    fn text_that_is_not_ascii_is_refused_wherever_it_falls() {
        for lead in 0..4 {
            for tail in 0..4 {
                for ch in ["€", "é", "\u{1F600}", "\u{FF11}"] {
                    let s = format!("{}{ch}{}", "a".repeat(lead), "b".repeat(tail));
                    assert_eq!(decode(&s), None, "{s:?}");
                }
            }
        }
        // Full-width and Arabic-Indic digits are digits to Unicode and not to this.
        assert_eq!(decode("\u{FF10}\u{FF11}"), None);
        assert_eq!(decode("\u{0661}\u{0662}"), None);
    }

    /// Every byte is judged as the standard library judges it, so no boundary of the digit ranges
    /// can move without this failing.
    #[test]
    fn every_byte_is_judged_as_std_judges_it() {
        for b in 0u8..=255 {
            let c = char::from(b);
            let s = format!("{c}{c}");
            assert_eq!(decode(&s).is_some(), b.is_ascii_hexdigit(), "{b:#04x}");
        }
    }

    #[test]
    fn the_exact_form_checks_the_length_too() {
        assert_eq!(decode_exact::<2>("abcd"), Some([0xab, 0xcd]));
        assert_eq!(decode_exact::<2>("ab"), None);
        assert_eq!(decode_exact::<2>("abcdef"), None);
        assert_eq!(decode_exact::<2>("€€"), None);
        assert_eq!(decode_exact::<0>(""), Some([]));
    }

    #[test]
    fn a_long_value_is_read_whole() {
        let s = "5a".repeat(10_000);
        assert_eq!(decode(&s).map(|v| v.len()), Some(10_000));
    }
}
