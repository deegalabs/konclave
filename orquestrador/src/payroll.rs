//! Payroll — the product's second face (spec §5.2, LOGICA §4): many payments in one
//! Orchard transaction (N outputs), approved once as a single envelope.
//!
//! Pure domain logic: build a plan from lines or a CSV, validate each line and the
//! aggregate (Σ + ZIP 317 fee ≤ available), and expose the outputs the orchestration
//! layer turns into a multi-output PCZT. CSV parsing is local (never uploaded).

use crate::money::Zatoshis;
use crate::validation::{
    available_to_propose, estimate_fee_for_payment, validate_memo, AddressKind, ValidationError,
};

/// One payroll line = one beneficiary/output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayrollLine {
    pub label: Option<String>,
    pub address: String,
    pub value: Zatoshis,
    /// Encrypted memo / payslip; empty means none.
    pub memo: String,
}

/// A payroll: the ordered list of outputs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PayrollPlan {
    pub lines: Vec<PayrollLine>,
}

/// The bottom-line the UI shows (spec §7 "8 pagamentos, total 4,2 ZEC…").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayrollSummary {
    pub count: usize,
    pub total: Zatoshis,
    pub estimated_fee: Zatoshis,
    pub total_with_fee: Zatoshis,
}

impl PayrollPlan {
    pub fn new(lines: Vec<PayrollLine>) -> Self {
        PayrollPlan { lines }
    }

    /// The outputs to feed the multi-output PCZT.
    pub fn outputs(&self) -> &[PayrollLine] {
        &self.lines
    }

    /// Validate every line and the aggregate against what's available to propose.
    /// Returns the summary (total, fee, total+fee) on success.
    pub fn validate(
        &self,
        confirmed: Zatoshis,
        reserved: Zatoshis,
    ) -> Result<PayrollSummary, ValidationError> {
        if self.lines.is_empty() {
            return Err(ValidationError::EmptyPayroll);
        }
        let mut total = Zatoshis::ZERO;
        for line in &self.lines {
            if line.value.is_zero() {
                return Err(ValidationError::ZeroValue);
            }
            validate_memo(&line.memo, AddressKind::classify(&line.address))?;
            total = total.checked_add(line.value)?;
        }
        let estimated_fee = estimate_fee_for_payment(self.lines.len() as u64, 1);
        let available = available_to_propose(confirmed, reserved, estimated_fee)?;
        if total > available {
            let total_with_fee = total.checked_add(estimated_fee)?;
            return Err(ValidationError::InsufficientFunds {
                needed: total_with_fee.as_u64(),
                available: confirmed
                    .checked_sub(reserved)
                    .unwrap_or(Zatoshis::ZERO)
                    .as_u64(),
            });
        }
        Ok(PayrollSummary {
            count: self.lines.len(),
            total,
            estimated_fee,
            total_with_fee: total.checked_add(estimated_fee)?,
        })
    }
}

/// A rejected CSV row: the 1-based source line and why it was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRowError {
    pub row: usize,
    pub reason: String,
}

/// The outcome of a CSV import (spec §4.3): accepted lines plus per-row errors, so the
/// UI can show "N accepted, M with errors" and allow a partial import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub plan: PayrollPlan,
    pub errors: Vec<ImportRowError>,
}

/// Import a payroll from CSV text: `label,address,value[,memo]`. Value is in ZEC
/// (decimal). A header row is auto-detected and skipped. The memo may contain commas
/// (it is everything after the third comma). Parsing is entirely local.
pub fn import_csv(csv: &str) -> ImportReport {
    let mut rows: Vec<(usize, &str)> = csv
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l))
        .filter(|(_, l)| !l.trim().is_empty())
        .collect();

    // Header detection: if the first row's value column doesn't parse as ZEC, it's a header.
    if let Some((_, first)) = rows.first() {
        let value_field = first.splitn(4, ',').nth(2).unwrap_or("");
        if Zatoshis::from_zec_str(value_field).is_err() {
            rows.remove(0);
        }
    }

    let mut lines = Vec::new();
    let mut errors = Vec::new();
    for (row, text) in rows {
        match parse_row(text) {
            Ok(line) => lines.push(line),
            Err(reason) => errors.push(ImportRowError { row, reason }),
        }
    }
    ImportReport {
        plan: PayrollPlan { lines },
        errors,
    }
}

fn parse_row(line: &str) -> Result<PayrollLine, String> {
    let parts: Vec<&str> = line.splitn(4, ',').collect();
    if parts.len() < 3 {
        return Err("expected columns: label,address,value[,memo]".into());
    }
    let label = {
        let l = parts[0].trim();
        if l.is_empty() {
            None
        } else {
            Some(l.to_string())
        }
    };
    let address = parts[1].trim().to_string();
    if address.is_empty() {
        return Err("empty address".into());
    }
    let value = Zatoshis::from_zec_str(parts[2])
        .map_err(|_| format!("invalid amount '{}'", parts[2].trim()))?;
    if value.is_zero() {
        return Err("amount must be greater than zero".into());
    }
    let memo = parts
        .get(3)
        .map(|m| m.trim().to_string())
        .unwrap_or_default();
    validate_memo(&memo, AddressKind::classify(&address)).map_err(|e| e.to_string())?;
    Ok(PayrollLine {
        label,
        address,
        value,
        memo,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zat(z: u64) -> Zatoshis {
        Zatoshis::from_u64(z).unwrap()
    }

    #[test]
    fn imports_csv_with_header_and_reports_bad_rows() {
        let csv = "\
label,address,value,memo
Alice,u1alice,0.5,ref maio
Bob,u1bob,0.25,
Carol,u1carol,oops,bad amount
,u1dave,0.1,no label ok
";
        let report = import_csv(csv);
        // 3 good lines (Alice, Bob, Dave); Carol rejected.
        assert_eq!(report.plan.lines.len(), 3);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].row, 4); // Carol is source line 4
        assert!(report.errors[0].reason.contains("invalid amount"));

        assert_eq!(report.plan.lines[0].label.as_deref(), Some("Alice"));
        assert_eq!(report.plan.lines[0].value, zat(50_000_000));
        assert_eq!(report.plan.lines[0].memo, "ref maio");
        assert_eq!(report.plan.lines[2].label, None); // Dave had empty label
    }

    #[test]
    fn header_is_optional() {
        let csv = "Alice,u1alice,0.5,\nBob,u1bob,0.25,";
        let report = import_csv(csv);
        assert_eq!(report.plan.lines.len(), 2);
        assert!(report.errors.is_empty());
    }

    #[test]
    fn memo_may_contain_commas() {
        let csv = "Alice,u1alice,0.5,salary for May, thanks!";
        let report = import_csv(csv);
        assert_eq!(report.plan.lines.len(), 1);
        assert_eq!(report.plan.lines[0].memo, "salary for May, thanks!");
    }

    #[test]
    fn transparent_destination_with_memo_is_rejected() {
        let csv = "Alice,t1transparent,0.5,payslip";
        let report = import_csv(csv);
        assert!(report.plan.lines.is_empty());
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].reason.contains("shielded"));
    }

    #[test]
    fn zero_and_empty_address_rejected() {
        let csv = "A,u1a,0,\nB,,0.5,";
        let report = import_csv(csv);
        assert_eq!(report.errors.len(), 2);
        assert!(report.plan.lines.is_empty());
    }

    #[test]
    fn validate_totals_and_fee() {
        // 3 recipients => fee = 5000 * max(2, 4) = 20_000 zat.
        let plan = PayrollPlan::new(vec![
            PayrollLine {
                label: None,
                address: "u1a".into(),
                value: zat(30_000),
                memo: String::new(),
            },
            PayrollLine {
                label: None,
                address: "u1b".into(),
                value: zat(30_000),
                memo: String::new(),
            },
            PayrollLine {
                label: None,
                address: "u1c".into(),
                value: zat(30_000),
                memo: String::new(),
            },
        ]);
        let summary = plan.validate(zat(200_000), Zatoshis::ZERO).unwrap();
        assert_eq!(summary.count, 3);
        assert_eq!(summary.total, zat(90_000));
        assert_eq!(summary.estimated_fee, zat(20_000));
        assert_eq!(summary.total_with_fee, zat(110_000));

        // Against 100_000 confirmed: 90_000 + 20_000 fee = 110_000 > 100_000 => reject.
        assert!(matches!(
            plan.validate(zat(100_000), Zatoshis::ZERO),
            Err(ValidationError::InsufficientFunds { .. })
        ));
    }

    #[test]
    fn empty_plan_is_rejected() {
        assert_eq!(
            PayrollPlan::default().validate(zat(1_000_000), Zatoshis::ZERO),
            Err(ValidationError::EmptyPayroll)
        );
    }
}
