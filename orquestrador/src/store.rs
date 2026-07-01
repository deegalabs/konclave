//! Local per-device state (spec LOGICA_E_REGRAS §0): the vaults this device knows and
//! the proposals in flight. On-chain is always the final truth about funds; this store
//! is a cache + the record of "who proposed / who approved" that the chain can't hold.
//!
//! Backed by bundled SQLite (no system dependency). Shares are NEVER stored here — they
//! live sealed via [`crate::secrets`] and in `frost-client`'s config; this store keeps
//! only public material and local bookkeeping.

use rusqlite::{params, Connection};

use crate::money::Zatoshis;
use crate::proposal::{ProposalState, Quorum};

#[derive(Debug)]
pub enum StoreError {
    Db(rusqlite::Error),
    /// A persisted value could not be mapped back to a domain type.
    Decode(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Db(e) => write!(f, "database error: {e}"),
            StoreError::Decode(e) => write!(f, "could not decode stored value: {e}"),
        }
    }
}
impl std::error::Error for StoreError {}
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Db(e)
    }
}

/// Whether a proposal is a single payment or a payroll (N outputs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalKind {
    Payment,
    Payroll,
}

/// A saved payee (spec: beneficiário como entidade). Public material — an address book
/// so the treasurer picks a name instead of pasting an address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Beneficiary {
    pub id: String,
    pub vault_id: String,
    pub name: String,
    pub address: String,
    pub memo: String,
}

/// A vault member = a quorum participant, identified by their FROST comm public key
/// (public material). Names are for the humans; the pubkey ties them to a signing share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub name: String,
    pub pubkey: String,
}

/// A vault known to this device (public material only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultRecord {
    pub id: String,
    pub name: String,
    pub quorum: Quorum,
    pub group_pubkey: String,
    pub orchard_address: String,
    pub ufvk: String,
    pub server_url: Option<String>,
}

/// A proposal as persisted (state + votes + optional broadcast txid).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalRecord {
    pub id: String,
    pub vault_id: String,
    pub kind: ProposalKind,
    pub state: ProposalState,
    pub proposer: String,
    pub value_total: Zatoshis,
    pub memo: Option<String>,
    /// Destination address (single payment). Payroll keeps destinations in its lines.
    pub to_address: Option<String>,
    pub expiry_unix: Option<i64>,
    pub txid: Option<String>,
    pub approvals: Vec<String>,
    pub refusals: Vec<String>,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &str) -> Result<Store, StoreError> {
        let conn = Connection::open(path)?;
        Self::from_conn(conn)
    }

    pub fn open_in_memory() -> Result<Store, StoreError> {
        Self::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> Result<Store, StoreError> {
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS vaults (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                threshold       INTEGER NOT NULL,
                total           INTEGER NOT NULL,
                group_pubkey    TEXT NOT NULL,
                orchard_address TEXT NOT NULL,
                ufvk            TEXT NOT NULL,
                server_url      TEXT
            );
            CREATE TABLE IF NOT EXISTS proposals (
                id           TEXT PRIMARY KEY,
                vault_id     TEXT NOT NULL REFERENCES vaults(id),
                kind         TEXT NOT NULL,
                state        TEXT NOT NULL,
                proposer     TEXT NOT NULL,
                value_total  INTEGER NOT NULL,
                memo         TEXT,
                to_address   TEXT,
                expiry_unix  INTEGER,
                txid         TEXT
            );
            CREATE TABLE IF NOT EXISTS proposal_votes (
                proposal_id  TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
                member_id    TEXT NOT NULL,
                vote         TEXT NOT NULL,
                PRIMARY KEY (proposal_id, member_id)
            );
            CREATE TABLE IF NOT EXISTS beneficiaries (
                id        TEXT PRIMARY KEY,
                vault_id  TEXT NOT NULL,
                name      TEXT NOT NULL,
                address   TEXT NOT NULL,
                memo      TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS vault_members (
                vault_id  TEXT NOT NULL REFERENCES vaults(id),
                idx       INTEGER NOT NULL,
                name      TEXT NOT NULL,
                pubkey    TEXT NOT NULL,
                PRIMARY KEY (vault_id, idx)
            );
            CREATE TABLE IF NOT EXISTS payroll_lines (
                proposal_id  TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
                idx          INTEGER NOT NULL,
                label        TEXT,
                address      TEXT NOT NULL,
                value        INTEGER NOT NULL,
                memo         TEXT NOT NULL,
                PRIMARY KEY (proposal_id, idx)
            );
            "#,
        )?;
        // Migration for DBs created before `to_address` existed. Succeeds once; the
        // "duplicate column" error on later opens is expected and ignored.
        let _ = conn.execute("ALTER TABLE proposals ADD COLUMN to_address TEXT", []);
        Ok(Store { conn })
    }

    // ---- vaults ----

    pub fn save_vault(&self, v: &VaultRecord) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO vaults (id, name, threshold, total, group_pubkey, orchard_address, ufvk, server_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, threshold=excluded.threshold, total=excluded.total,
               group_pubkey=excluded.group_pubkey, orchard_address=excluded.orchard_address,
               ufvk=excluded.ufvk, server_url=excluded.server_url",
            params![
                v.id, v.name, v.quorum.threshold, v.quorum.total, v.group_pubkey,
                v.orchard_address, v.ufvk, v.server_url
            ],
        )?;
        Ok(())
    }

    pub fn get_vault(&self, id: &str) -> Result<Option<VaultRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, threshold, total, group_pubkey, orchard_address, ufvk, server_url
             FROM vaults WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_vault)?;
        match rows.next() {
            Some(r) => Ok(Some(r??)),
            None => Ok(None),
        }
    }

    pub fn list_vaults(&self) -> Result<Vec<VaultRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, threshold, total, group_pubkey, orchard_address, ufvk, server_url
             FROM vaults ORDER BY name",
        )?;
        let rows = stmt.query_map([], row_to_vault)?;
        rows.map(|r| r?).collect()
    }

    // ---- proposals ----

    /// Upsert a proposal and replace its votes atomically.
    pub fn save_proposal(&mut self, p: &ProposalRecord) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO proposals (id, vault_id, kind, state, proposer, value_total, memo, to_address, expiry_unix, txid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               state=excluded.state, value_total=excluded.value_total, memo=excluded.memo,
               to_address=excluded.to_address, expiry_unix=excluded.expiry_unix, txid=excluded.txid",
            params![
                p.id, p.vault_id, kind_str(p.kind), state_str(p.state), p.proposer,
                p.value_total.as_u64() as i64, p.memo, p.to_address, p.expiry_unix, p.txid
            ],
        )?;
        tx.execute("DELETE FROM proposal_votes WHERE proposal_id = ?1", params![p.id])?;
        for m in &p.approvals {
            tx.execute(
                "INSERT OR REPLACE INTO proposal_votes (proposal_id, member_id, vote) VALUES (?1, ?2, 'approve')",
                params![p.id, m],
            )?;
        }
        for m in &p.refusals {
            tx.execute(
                "INSERT OR REPLACE INTO proposal_votes (proposal_id, member_id, vote) VALUES (?1, ?2, 'refuse')",
                params![p.id, m],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_proposal(&self, id: &str) -> Result<Option<ProposalRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, vault_id, kind, state, proposer, value_total, memo, expiry_unix, txid, to_address
             FROM proposals WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| row_to_proposal_head(r))?;
        let head = match rows.next() {
            Some(r) => r??,
            None => return Ok(None),
        };
        Ok(Some(self.attach_votes(head)?))
    }

    /// Open proposals (awaiting/ready/sent) for a vault — the "pending" list (spec §6.7).
    pub fn list_open_proposals(&self, vault_id: &str) -> Result<Vec<ProposalRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, vault_id, kind, state, proposer, value_total, memo, expiry_unix, txid, to_address
             FROM proposals
             WHERE vault_id = ?1 AND state IN ('awaiting','ready','sent')",
        )?;
        let heads: Vec<ProposalRecord> = stmt
            .query_map(params![vault_id], |r| row_to_proposal_head(r))?
            .map(|r| r?)
            .collect::<Result<_, StoreError>>()?;
        heads.into_iter().map(|h| self.attach_votes(h)).collect()
    }

    /// Add or update a saved beneficiary.
    pub fn save_beneficiary(&self, b: &Beneficiary) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO beneficiaries (id, vault_id, name, address, memo) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, memo=excluded.memo",
            params![b.id, b.vault_id, b.name, b.address, b.memo],
        )?;
        Ok(())
    }

    /// The saved beneficiaries for a vault, by name.
    pub fn list_beneficiaries(&self, vault_id: &str) -> Result<Vec<Beneficiary>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, vault_id, name, address, memo FROM beneficiaries WHERE vault_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![vault_id], |r| {
            Ok(Beneficiary {
                id: r.get(0)?,
                vault_id: r.get(1)?,
                name: r.get(2)?,
                address: r.get(3)?,
                memo: r.get(4)?,
            })
        })?;
        rows.map(|r| r.map_err(StoreError::from)).collect()
    }

    /// Remove a saved beneficiary. Returns whether a row was deleted.
    pub fn delete_beneficiary(&self, id: &str) -> Result<bool, StoreError> {
        let n = self.conn.execute("DELETE FROM beneficiaries WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    /// Replace a vault's member list (public material: names + comm pubkeys).
    pub fn save_vault_members(&mut self, vault_id: &str, members: &[Member]) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM vault_members WHERE vault_id = ?1", params![vault_id])?;
        for (i, m) in members.iter().enumerate() {
            tx.execute(
                "INSERT INTO vault_members (vault_id, idx, name, pubkey) VALUES (?1, ?2, ?3, ?4)",
                params![vault_id, i as i64, m.name, m.pubkey],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// A vault's members, in order.
    pub fn get_vault_members(&self, vault_id: &str) -> Result<Vec<Member>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, pubkey FROM vault_members WHERE vault_id = ?1 ORDER BY idx")?;
        let rows = stmt.query_map(params![vault_id], |r| {
            Ok(Member { name: r.get(0)?, pubkey: r.get(1)? })
        })?;
        rows.map(|r| r.map_err(StoreError::from)).collect()
    }

    /// Replace a payroll proposal's output lines (one row per beneficiary).
    pub fn save_payroll_lines(
        &mut self,
        proposal_id: &str,
        lines: &[crate::payroll::PayrollLine],
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM payroll_lines WHERE proposal_id = ?1", params![proposal_id])?;
        for (i, l) in lines.iter().enumerate() {
            tx.execute(
                "INSERT INTO payroll_lines (proposal_id, idx, label, address, value, memo)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![proposal_id, i as i64, l.label, l.address, l.value.as_u64() as i64, l.memo],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The output lines of a payroll proposal (empty for a single payment).
    pub fn get_payroll_lines(
        &self,
        proposal_id: &str,
    ) -> Result<Vec<crate::payroll::PayrollLine>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT label, address, value, memo FROM payroll_lines WHERE proposal_id = ?1 ORDER BY idx",
        )?;
        let rows = stmt.query_map(params![proposal_id], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (label, address, value, memo) = row?;
            let value = Zatoshis::from_u64(value as u64).map_err(|e| StoreError::Decode(e.to_string()))?;
            out.push(crate::payroll::PayrollLine { label, address, value, memo });
        }
        Ok(out)
    }

    /// Mark every awaiting proposal whose expiry has passed as `expired` (spec §6.3).
    /// Called on read paths so time-based expiry is enforced without a background job.
    /// Returns how many were expired.
    pub fn expire_due(&self, now_unix: i64) -> Result<usize, StoreError> {
        let n = self.conn.execute(
            "UPDATE proposals SET state = 'expired'
             WHERE state = 'awaiting' AND expiry_unix IS NOT NULL AND expiry_unix < ?1",
            params![now_unix],
        )?;
        Ok(n)
    }

    /// Every proposal for a vault, newest first — the full ledger (spec §6.7), including
    /// terminal states (sent/confirmed/rejected/expired) for the accounting export.
    pub fn list_all_proposals(&self, vault_id: &str) -> Result<Vec<ProposalRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, vault_id, kind, state, proposer, value_total, memo, expiry_unix, txid, to_address
             FROM proposals WHERE vault_id = ?1 ORDER BY expiry_unix DESC, id DESC",
        )?;
        let heads: Vec<ProposalRecord> = stmt
            .query_map(params![vault_id], |r| row_to_proposal_head(r))?
            .map(|r| r?)
            .collect::<Result<_, StoreError>>()?;
        heads.into_iter().map(|h| self.attach_votes(h)).collect()
    }

    fn attach_votes(&self, mut p: ProposalRecord) -> Result<ProposalRecord, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT member_id, vote FROM proposal_votes WHERE proposal_id = ?1")?;
        let rows = stmt.query_map(params![p.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (member, vote) = row?;
            match vote.as_str() {
                "approve" => p.approvals.push(member),
                "refuse" => p.refusals.push(member),
                other => return Err(StoreError::Decode(format!("unknown vote '{other}'"))),
            }
        }
        p.approvals.sort();
        p.refusals.sort();
        Ok(p)
    }
}

// ---- row mappers & enum <-> text ----

fn row_to_vault(r: &rusqlite::Row) -> rusqlite::Result<Result<VaultRecord, StoreError>> {
    let threshold: i64 = r.get(2)?;
    let total: i64 = r.get(3)?;
    let quorum = match Quorum::new(threshold as u16, total as u16) {
        Ok(q) => q,
        Err(e) => return Ok(Err(StoreError::Decode(e.to_string()))),
    };
    Ok(Ok(VaultRecord {
        id: r.get(0)?,
        name: r.get(1)?,
        quorum,
        group_pubkey: r.get(4)?,
        orchard_address: r.get(5)?,
        ufvk: r.get(6)?,
        server_url: r.get(7)?,
    }))
}

fn row_to_proposal_head(r: &rusqlite::Row) -> rusqlite::Result<Result<ProposalRecord, StoreError>> {
    let kind = match kind_from(&r.get::<_, String>(2)?) {
        Ok(k) => k,
        Err(e) => return Ok(Err(e)),
    };
    let state = match state_from(&r.get::<_, String>(3)?) {
        Ok(s) => s,
        Err(e) => return Ok(Err(e)),
    };
    let value_raw: i64 = r.get(5)?;
    let value_total = match Zatoshis::from_u64(value_raw as u64) {
        Ok(v) => v,
        Err(e) => return Ok(Err(StoreError::Decode(e.to_string()))),
    };
    Ok(Ok(ProposalRecord {
        id: r.get(0)?,
        vault_id: r.get(1)?,
        kind,
        state,
        proposer: r.get(4)?,
        value_total,
        memo: r.get(6)?,
        expiry_unix: r.get(7)?,
        txid: r.get(8)?,
        to_address: r.get(9)?,
        approvals: Vec::new(),
        refusals: Vec::new(),
    }))
}

fn kind_str(k: ProposalKind) -> &'static str {
    match k {
        ProposalKind::Payment => "payment",
        ProposalKind::Payroll => "payroll",
    }
}
fn kind_from(s: &str) -> Result<ProposalKind, StoreError> {
    match s {
        "payment" => Ok(ProposalKind::Payment),
        "payroll" => Ok(ProposalKind::Payroll),
        other => Err(StoreError::Decode(format!("unknown kind '{other}'"))),
    }
}

fn state_str(s: ProposalState) -> &'static str {
    match s {
        ProposalState::Draft => "draft",
        ProposalState::Awaiting => "awaiting",
        ProposalState::Ready => "ready",
        ProposalState::Sent => "sent",
        ProposalState::Confirmed => "confirmed",
        ProposalState::Rejected => "rejected",
        ProposalState::Expired => "expired",
        ProposalState::Cancelled => "cancelled",
    }
}
fn state_from(s: &str) -> Result<ProposalState, StoreError> {
    Ok(match s {
        "draft" => ProposalState::Draft,
        "awaiting" => ProposalState::Awaiting,
        "ready" => ProposalState::Ready,
        "sent" => ProposalState::Sent,
        "confirmed" => ProposalState::Confirmed,
        "rejected" => ProposalState::Rejected,
        "expired" => ProposalState::Expired,
        "cancelled" => ProposalState::Cancelled,
        other => return Err(StoreError::Decode(format!("unknown state '{other}'"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zat(z: u64) -> Zatoshis {
        Zatoshis::from_u64(z).unwrap()
    }

    fn sample_vault() -> VaultRecord {
        VaultRecord {
            id: "vault-1".into(),
            name: "Tesouraria".into(),
            quorum: Quorum::new(2, 3).unwrap(),
            group_pubkey: "0ab93649".into(),
            orchard_address: "u1t2qphc0v".into(),
            ufvk: "uview1m02wyj".into(),
            server_url: Some("127.0.0.1:2744".into()),
        }
    }

    #[test]
    fn vault_roundtrip_and_list() {
        let s = Store::open_in_memory().unwrap();
        let v = sample_vault();
        s.save_vault(&v).unwrap();
        assert_eq!(s.get_vault("vault-1").unwrap().as_ref(), Some(&v));
        assert!(s.get_vault("nope").unwrap().is_none());
        assert_eq!(s.list_vaults().unwrap(), vec![v]);
    }

    #[test]
    fn vault_upsert_updates() {
        let s = Store::open_in_memory().unwrap();
        let mut v = sample_vault();
        s.save_vault(&v).unwrap();
        v.name = "Renamed".into();
        s.save_vault(&v).unwrap();
        assert_eq!(s.get_vault("vault-1").unwrap().unwrap().name, "Renamed");
        assert_eq!(s.list_vaults().unwrap().len(), 1);
    }

    fn sample_proposal() -> ProposalRecord {
        ProposalRecord {
            id: "prop-1".into(),
            vault_id: "vault-1".into(),
            kind: ProposalKind::Payment,
            state: ProposalState::Awaiting,
            proposer: "alice".into(),
            value_total: zat(20_000),
            memo: Some("ref maio".into()),
            to_address: Some("u1destalice".into()),
            expiry_unix: Some(1_800_000_000),
            txid: None,
            approvals: vec!["alice".into()],
            refusals: vec![],
        }
    }

    #[test]
    fn proposal_roundtrip_with_votes() {
        let mut s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();
        let p = sample_proposal();
        s.save_proposal(&p).unwrap();
        assert_eq!(s.get_proposal("prop-1").unwrap().as_ref(), Some(&p));
    }

    #[test]
    fn proposal_upsert_replaces_state_and_votes() {
        let mut s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();
        let mut p = sample_proposal();
        s.save_proposal(&p).unwrap();

        // bob approves -> quorum reached -> Ready, then broadcast with a txid.
        p.approvals = vec!["alice".into(), "bob".into()];
        p.state = ProposalState::Sent;
        p.txid = Some("f63ee64d".into());
        s.save_proposal(&p).unwrap();

        let loaded = s.get_proposal("prop-1").unwrap().unwrap();
        assert_eq!(loaded.state, ProposalState::Sent);
        assert_eq!(loaded.approvals, vec!["alice".to_string(), "bob".to_string()]);
        assert_eq!(loaded.txid.as_deref(), Some("f63ee64d"));
    }

    #[test]
    fn list_open_excludes_terminal_states() {
        let mut s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();

        let mut awaiting = sample_proposal();
        s.save_proposal(&awaiting).unwrap();

        let mut confirmed = sample_proposal();
        confirmed.id = "prop-2".into();
        confirmed.state = ProposalState::Confirmed;
        s.save_proposal(&confirmed).unwrap();

        let mut rejected = sample_proposal();
        rejected.id = "prop-3".into();
        rejected.state = ProposalState::Rejected;
        s.save_proposal(&rejected).unwrap();

        let open = s.list_open_proposals("vault-1").unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, "prop-1");

        // Move the open one to Sent (still open), confirm it stays listed.
        awaiting.state = ProposalState::Sent;
        s.save_proposal(&awaiting).unwrap();
        assert_eq!(s.list_open_proposals("vault-1").unwrap().len(), 1);
    }

    #[test]
    fn list_all_includes_terminal_states() {
        let mut s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();

        let awaiting = sample_proposal();
        s.save_proposal(&awaiting).unwrap();
        let mut confirmed = sample_proposal();
        confirmed.id = "prop-2".into();
        confirmed.state = ProposalState::Confirmed;
        confirmed.txid = Some("abcd".into());
        s.save_proposal(&confirmed).unwrap();

        // list_open drops the confirmed one; list_all keeps both.
        assert_eq!(s.list_open_proposals("vault-1").unwrap().len(), 1);
        assert_eq!(s.list_all_proposals("vault-1").unwrap().len(), 2);
    }

    #[test]
    fn expire_due_marks_past_awaiting() {
        let mut s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();

        let mut past = sample_proposal();
        past.expiry_unix = Some(1_000); // long past
        s.save_proposal(&past).unwrap();

        let mut future = sample_proposal();
        future.id = "prop-future".into();
        future.expiry_unix = Some(i64::MAX);
        s.save_proposal(&future).unwrap();

        let n = s.expire_due(2_000).unwrap();
        assert_eq!(n, 1);
        assert_eq!(s.get_proposal("prop-1").unwrap().unwrap().state, ProposalState::Expired);
        assert_eq!(s.get_proposal("prop-future").unwrap().unwrap().state, ProposalState::Awaiting);
        // Idempotent: a second sweep expires nothing new.
        assert_eq!(s.expire_due(2_000).unwrap(), 0);
    }

    #[test]
    fn beneficiaries_crud() {
        let s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();
        let b = Beneficiary {
            id: "b1".into(), vault_id: "vault-1".into(), name: "Alice".into(),
            address: "u1alice".into(), memo: "salário".into(),
        };
        s.save_beneficiary(&b).unwrap();
        assert_eq!(s.list_beneficiaries("vault-1").unwrap(), vec![b.clone()]);
        // Upsert updates.
        let mut b2 = b.clone();
        b2.address = "u1alice2".into();
        s.save_beneficiary(&b2).unwrap();
        assert_eq!(s.list_beneficiaries("vault-1").unwrap()[0].address, "u1alice2");
        // Delete.
        assert!(s.delete_beneficiary("b1").unwrap());
        assert!(s.list_beneficiaries("vault-1").unwrap().is_empty());
        assert!(!s.delete_beneficiary("b1").unwrap());
    }

    #[test]
    fn vault_members_roundtrip() {
        let mut s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();
        let members = vec![
            Member { name: "Alice".into(), pubkey: "317db593".into() },
            Member { name: "Bob".into(), pubkey: "2ca6d736".into() },
        ];
        s.save_vault_members("vault-1", &members).unwrap();
        assert_eq!(s.get_vault_members("vault-1").unwrap(), members);
        // Re-saving replaces.
        s.save_vault_members("vault-1", &members[..1]).unwrap();
        assert_eq!(s.get_vault_members("vault-1").unwrap().len(), 1);
        assert!(s.get_vault_members("nope").unwrap().is_empty());
    }

    #[test]
    fn payroll_lines_roundtrip() {
        use crate::payroll::PayrollLine;
        let mut s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();
        let mut p = sample_proposal();
        p.kind = ProposalKind::Payroll;
        p.to_address = None;
        s.save_proposal(&p).unwrap();

        let lines = vec![
            PayrollLine { label: Some("Alice".into()), address: "u1alice".into(), value: zat(30_000), memo: "maio".into() },
            PayrollLine { label: None, address: "u1bob".into(), value: zat(20_000), memo: String::new() },
        ];
        s.save_payroll_lines("prop-1", &lines).unwrap();
        assert_eq!(s.get_payroll_lines("prop-1").unwrap(), lines);

        // Re-saving replaces (no duplication).
        s.save_payroll_lines("prop-1", &lines[..1]).unwrap();
        assert_eq!(s.get_payroll_lines("prop-1").unwrap().len(), 1);
        // A payment proposal has no lines.
        assert!(s.get_payroll_lines("nope").unwrap().is_empty());
    }

    #[test]
    fn corrupt_state_is_explicit_error() {
        let s = Store::open_in_memory().unwrap();
        s.save_vault(&sample_vault()).unwrap();
        // Insert a proposal row with a bogus state directly.
        s.conn
            .execute(
                "INSERT INTO proposals (id, vault_id, kind, state, proposer, value_total)
                 VALUES ('x','vault-1','payment','bogus','alice',1)",
                [],
            )
            .unwrap();
        assert!(matches!(s.get_proposal("x"), Err(StoreError::Decode(_))));
    }
}
