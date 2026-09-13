-- 003 — Free-text journal notes (T3-13a).
--
-- The Journal was two prompted fields, "How is your energy? Any pains?" and "Intentions for
-- next phase?", which framed it as a periodic ceremony rather than somewhere to jot a thought
-- between sets. It becomes one free-text field: an info dump, written in eight seconds.
--
-- Data-preserving. The old columns are kept and backfilled into the new one rather than
-- dropped, because they hold real entries and because a migration that discards user writing
-- to tidy a schema is the wrong trade.

ALTER TABLE journal_entries
    ADD COLUMN IF NOT EXISTS note TEXT;

-- Fold any existing energy/intentions pair into a single note. concat_ws skips NULLs, so an
-- entry with only one of the two does not end up with a stray separator.
UPDATE journal_entries
   SET note = NULLIF(
           concat_ws(
               E'\n\n',
               NULLIF(btrim(COALESCE(energy, '')), ''),
               NULLIF(btrim(COALESCE(intentions, '')), '')
           ),
           ''
       )
 WHERE note IS NULL;

COMMENT ON COLUMN journal_entries.note IS
    'T3-13a: free-text entry. energy/intentions are retained for entries written before 003 and are no longer populated.';
