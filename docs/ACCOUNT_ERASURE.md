# Account erasure

The privacy policy (§7, §8) promises that a person's account data is removed from the live
database within 30 days of a deletion request, that rooms are deleted with their host's account,
and that Elric records, the Google identity and the date of birth go with the account. Requests
arrive at the privacy mailbox; an operator verifies the requester and runs one procedure:
`server/account/erase.ts` through `scripts/account-erase.ts`.

```sh
# Dry run: the exact counts, nothing written.
pnpm account:erase -- erase --account <account id>
# Erase. --confirm needs --ledger: the erasure ledger, kept outside the database.
pnpm account:erase -- erase --account <account id> --ledger <ledger file> --confirm
# After restoring a backup: erase every account of the ledger again (dry run without --confirm).
pnpm account:erase -- reapply --ledger <ledger file> --confirm
```

Hosted: `CITY_HOSTED=1` and `DATABASE_URL`, as for the app. Locally: `CITY_DATA_DIR` (default
`.local/data`), with the app stopped.

## What one run does (one transaction)

| Data                                                                                   | What happens                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rooms the account hosts                                                                | Deleted with everything in them (messages, tasks, files, members, mentions, receipts, Elric turns of any owner in them, their cost kept in the anonymous totals).                                                                                                                                                                                              |
| Elric                                                                                  | Every Elric record of the account (eraseElricOwnerIn), private Elric chats included.                                                                                                                                                                                                                                                                           |
| Private data                                                                           | Sessions, AI app access, workspace keys, credentials, manifests, presence, enrollments, webhooks, Google identity and sign-in flows, date of birth, newsletter subscription, outgoing email, published results, Feed requests, auto-reply settings and keys, invitations, connection requests, GitHub installations, read marks, the workspace and its agents. |
| Its agents' offers                                                                     | Removed and withdrawn from the Feed, as a revoke does.                                                                                                                                                                                                                                                                                                         |
| What it wrote in rooms hosted by others, and direct messages with other owners' agents | Kept for the other side. The author becomes a random pseudonym of this erasure (`erased:<uuid>`), names become "Former member". Its memberships end.                                                                                                                                                                                                           |
| Direct messages between its own agents                                                 | Deleted, with those pairs' conversations: no one else reads them.                                                                                                                                                                                                                                                                                              |
| Retained records (`RETAINED`)                                                          | Kept, holding only the opaque account id: payments, wallets, withdrawals, identities and receipts on Base; sales and paid calls; the public count log; the newsletter consent proof (2 years at most); the Google relink cooldown (30 days); the terms acceptance history.                                                                                     |
| The account row                                                                        | Deleted, unless a retained record holds a foreign key to it: then a tombstone (name "Deleted account", no password, never able to sign in, an empty workspace).                                                                                                                                                                                                |

The agents leave the public count as by any purge: the next daily checkpoint lists them as
withdrawn. The count log, its noon cut and its signing are not touched.

## The ledger

A confirmed erase is refused without `--ledger`. Each line names the account by the SHA-256 of
its id and the time, and nothing else:
`{"account_sha256": "<SHA-256 of the account id>", "erased_at": "<ISO time>", "state": "<state>", "op": "<operation id>"}`.
Account ids are random UUIDs, so the hash names no one; the operation id is a random UUID of
the run, the same on each of its lines. One confirmed run
(`server/account/erase-ledger.ts`):

1. Appends the `intent` line and flushes the file and its directory to disk. If that fails,
   nothing is erased. On Windows a directory cannot be flushed, so there only the file is
   flushed and the new directory entry's durability after a power loss rests on the file system:
   a platform limitation. Run confirmed erasures on Linux or macOS where that guarantee matters.
2. Commits the erasure (the one transaction above).
3. Appends the `done` line and flushes it.

If the erasure is refused (no such account, not a person, erased already), nothing was committed
and an `aborted` line cancels that run's intent. An aborted line cancels only the intent of its
own operation id: never a done line, and never another run, even one at the same time. On any
failure the run prints the exact state (`intent`, `erasure`: committed, not committed or
unknown, `done`, `aborted`) and exits non-zero. An intent without a done line still counts: the
erasure may have committed, so run `reapply` with the ledger to finish it. `reapply` erases every account of an intent or done line that is not
cancelled (lines from older ledgers, without a state, count as done), skips accounts already
erased or absent, and is safe to run again.

Keep the ledger outside the database (backups are rolling, 30 days at most): after any restore,
run `reapply` with it before the app serves traffic.

tests/account-erase.test.ts checks that an erased account's id is left only in the `RETAINED`
columns and its name and email nowhere.
