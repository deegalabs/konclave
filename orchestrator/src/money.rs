//! Money as zatoshis — the only unit the domain trusts.
//!
//! ZEC amounts are always integers of zatoshis (1 ZEC = 100_000_000 zat). Floating
//! point never touches value math. All arithmetic is checked; overflow and amounts
//! above the money supply are explicit errors, never silent wraps.

use core::fmt;

/// Zatoshis per ZEC.
pub const COIN: u64 = 100_000_000;

/// Maximum representable money (21M ZEC), per Zcash consensus.
pub const MAX_MONEY: u64 = 21_000_000 * COIN;

#[derive(Debug, PartialEq, Eq)]
pub enum MoneyError {
    /// Amount exceeds the money supply (21M ZEC).
    AboveMaxMoney(u64),
    /// A checked operation overflowed or underflowed.
    Overflow,
    /// The zatoshi string could not be parsed.
    Parse,
}

impl fmt::Display for MoneyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MoneyError::AboveMaxMoney(z) => {
                write!(f, "amount {z} zat exceeds the maximum money supply")
            }
            MoneyError::Overflow => write!(f, "value arithmetic overflowed"),
            MoneyError::Parse => write!(f, "could not parse zatoshi amount"),
        }
    }
}

impl std::error::Error for MoneyError {}

/// A non-negative amount of zatoshis, guaranteed to be within the money supply.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Zatoshis(u64);

impl Zatoshis {
    pub const ZERO: Zatoshis = Zatoshis(0);

    /// Construct from a raw zatoshi count, rejecting amounts above the supply.
    pub fn from_u64(zat: u64) -> Result<Self, MoneyError> {
        if zat > MAX_MONEY {
            Err(MoneyError::AboveMaxMoney(zat))
        } else {
            Ok(Zatoshis(zat))
        }
    }

    pub const fn as_u64(self) -> u64 {
        self.0
    }

    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// Checked addition; errors on overflow or if the sum exceeds the supply.
    pub fn checked_add(self, other: Zatoshis) -> Result<Zatoshis, MoneyError> {
        let sum = self.0.checked_add(other.0).ok_or(MoneyError::Overflow)?;
        Zatoshis::from_u64(sum)
    }

    /// Checked subtraction; errors on underflow (never goes negative).
    pub fn checked_sub(self, other: Zatoshis) -> Result<Zatoshis, MoneyError> {
        self.0
            .checked_sub(other.0)
            .map(Zatoshis)
            .ok_or(MoneyError::Overflow)
    }

    /// Multiply by a scalar (e.g. fee = marginal_fee * actions); checked.
    pub fn checked_mul_u64(self, factor: u64) -> Result<Zatoshis, MoneyError> {
        let product = self.0.checked_mul(factor).ok_or(MoneyError::Overflow)?;
        Zatoshis::from_u64(product)
    }

    /// Human-readable ZEC string with 8 decimals (display only; never for math).
    pub fn to_zec_string(self) -> String {
        let whole = self.0 / COIN;
        let frac = self.0 % COIN;
        format!("{whole}.{frac:08}")
    }

    /// Parse a ZEC decimal string (e.g. "0.5", "1", ".05") into zatoshis, WITHOUT
    /// floating point. Rejects more than 8 fractional digits and non-numeric input.
    pub fn from_zec_str(s: &str) -> Result<Zatoshis, MoneyError> {
        let s = s.trim();
        let (whole_str, frac_str) = match s.split_once('.') {
            Some((w, f)) => (w, f),
            None => (s, ""),
        };
        if whole_str.is_empty() && frac_str.is_empty() {
            return Err(MoneyError::Parse); // "" or "."
        }
        if frac_str.len() > 8 {
            return Err(MoneyError::Parse);
        }
        let all_digits = |t: &str| t.chars().all(|c| c.is_ascii_digit());
        if !all_digits(whole_str) || !all_digits(frac_str) {
            return Err(MoneyError::Parse);
        }
        let whole: u64 = if whole_str.is_empty() {
            0
        } else {
            whole_str.parse().map_err(|_| MoneyError::Parse)?
        };
        let frac: u64 = if frac_str.is_empty() {
            0
        } else {
            format!("{frac_str:0<8}")
                .parse()
                .map_err(|_| MoneyError::Parse)?
        };
        let zat = whole
            .checked_mul(COIN)
            .ok_or(MoneyError::Overflow)?
            .checked_add(frac)
            .ok_or(MoneyError::Overflow)?;
        Zatoshis::from_u64(zat)
    }
}

impl fmt::Display for Zatoshis {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} zat", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_above_max_money() {
        assert_eq!(
            Zatoshis::from_u64(MAX_MONEY + 1),
            Err(MoneyError::AboveMaxMoney(MAX_MONEY + 1))
        );
        assert!(Zatoshis::from_u64(MAX_MONEY).is_ok());
    }

    #[test]
    fn add_detects_overflow() {
        let big = Zatoshis::from_u64(MAX_MONEY).unwrap();
        // MAX + 1 zat exceeds the supply.
        assert_eq!(
            big.checked_add(Zatoshis::from_u64(1).unwrap()),
            Err(MoneyError::AboveMaxMoney(MAX_MONEY + 1))
        );
    }

    #[test]
    fn sub_never_goes_negative() {
        let a = Zatoshis::from_u64(100).unwrap();
        let b = Zatoshis::from_u64(200).unwrap();
        assert_eq!(a.checked_sub(b), Err(MoneyError::Overflow));
        assert_eq!(b.checked_sub(a), Ok(Zatoshis::from_u64(100).unwrap()));
    }

    #[test]
    fn zec_formatting() {
        // 0.0001 ZEC = 10_000 zat (the ZIP 317 minimum fee).
        assert_eq!(
            Zatoshis::from_u64(10_000).unwrap().to_zec_string(),
            "0.00010000"
        );
        assert_eq!(
            Zatoshis::from_u64(COIN).unwrap().to_zec_string(),
            "1.00000000"
        );
        assert_eq!(Zatoshis::ZERO.to_zec_string(), "0.00000000");
    }

    #[test]
    fn parse_zec_without_float() {
        let z = |s: &str| Zatoshis::from_zec_str(s).unwrap().as_u64();
        assert_eq!(z("1"), COIN);
        assert_eq!(z("0.5"), 50_000_000);
        assert_eq!(z(".05"), 5_000_000);
        assert_eq!(z("0.00010000"), 10_000);
        assert_eq!(z("0.0001"), 10_000); // trailing zeros implied
        assert_eq!(z(" 2.5 "), 250_000_000); // trimmed
        assert_eq!(z("0"), 0);
    }

    #[test]
    fn parse_zec_rejects_garbage() {
        for bad in ["", ".", "abc", "1.2.3", "-1", "0.123456789", "1e8", "0,5"] {
            assert!(
                Zatoshis::from_zec_str(bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn zec_roundtrips_through_string() {
        for zat in [0u64, 1, 10_000, 50_000_000, COIN, 21_000_000 * COIN] {
            let z = Zatoshis::from_u64(zat).unwrap();
            assert_eq!(Zatoshis::from_zec_str(&z.to_zec_string()).unwrap(), z);
        }
    }
}
