# Feature PR completion protocol

Status: accepted

The Maestro treats a registered Feature PR as the single merge candidate for a Feature. Marking that
PR Ready for review is an explicit human authorization to run the final gated completion protocol:
successful CI and secret checks, a read-only agent review of the exact head commit, a second gate check,
and a head-matched merge. The user action authorizes the merge only if every gate passes; it does not
authorize bypassing checks, changing the reviewed head, or deploying.

After GitHub confirms the Feature PR was merged, associated Work PRs are closed as superseded, their
remote head branches are deleted explicitly even when GitHub already marked the PRs merged or closed,
their Tasks are completed, clean inactive worktrees and local branches are removed, and a completion
report is sent through Telegram. Dirty or active worktrees fail safe into cleanup pending. This narrowly supersedes the
no-automatic-merge consequence recorded in ADR 0001 for registered Feature PRs only; ordinary Task PRs
retain their existing human merge gate.
