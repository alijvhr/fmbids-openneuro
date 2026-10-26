# FAIR m-BIDS search (Stage 3)

Subject-level search over the FAIR m-BIDS metadata described in [FAIR m-BIDS (Stage 1)](fair-mbids.md),
following the Stage 2 design report. Existing dataset search (`search`, `advancedSearch`, the
`datasets` index) is unchanged.

## Architecture decision

**Chosen:** a separate subject index, `fairmbids-subjects`, with one document per dataset-local
subject and a `nested` list of sessions. This is the report's option C, without its acquisition index.

| Option | Verdict |
| --- | --- |
| A. Extend the `datasets` index | Rejected. `subjectMetadata` is a plain object array, so values from different subjects or sessions combine in queries (Elasticsearch flattens object arrays). |
| B/C. Subject index with nested sessions | **Chosen.** Same-session predicates are evaluated inside one nested session; subject counts are exact because one document is one subject. |
| C/D. Plus an acquisition index | Not built. Stage 1 extracts no acquisition parameters (TR, sampling rate, tracer), so it would have nothing typed to index. |

It follows the existing index pattern: the physical index name is `fairmbids-subjects-<mapping hash>`,
and the stable alias `fairmbids-subjects` is moved by the indexer.

## Indexing

`indexDataset()` in `@fmbids-openneuro/search` indexes the dataset document as before, then calls
`indexFairMBidsSubjects()` for the dataset's latest snapshot. Both the indexer and the server
reindex queue use `indexDataset()`, so subject documents follow every dataset index.

1. It reads `identifiers.tsv`, `participants.tsv` and each `sub-<label>/sub-<label>_sessions.tsv`
   through the API's file route, using the indexing token.
2. It builds one document per subject that appears in `identifiers.tsv`.
3. It bulk-indexes them (`_id` = `subject_key`), then deletes that dataset's subject documents
   that were not just written. Re-indexing is therefore idempotent, and removed subjects disappear
   without a gap in search.

Datasets without `identifiers.tsv` get no subject documents. A failure in this step is logged
and never blocks dataset indexing. Deleting a dataset also deletes its subject documents.

Only the latest snapshot is indexed, and sessions come only from `ses-` directories, so dataset
versions are never counted as visits.

### Indexed fields

| Field | Type | Source | Missing value means |
| --- | --- | --- | --- |
| `subject_key` | keyword | `<dataset>:<participant_id>` | – |
| `dataset_id`, `snapshot_tag` | keyword | dataset, latest snapshot | – |
| `public` | boolean | dataset | – |
| `participant_id` | keyword | `sub-` directory in `file_path` | – |
| `demographics.age` | float | `participants.tsv` `age` | not recorded (`n/a` or not numeric) |
| `demographics.sex`, `.group` | keyword | `participants.tsv` | not recorded |
| `sessions[]` | nested | `ses-` directory in `file_path`; one session with `session_id: null` when the subject has no `ses-` directories | – |
| `sessions.modalities` | keyword | lower-cased `modality` column of `identifiers.tsv` | – |
| `sessions.session_order` | integer | rank of `sessions.tsv` `acq_time` | chronology unknown (set only when **every** session of the subject has `acq_time`) |
| `sessions.relative_time_days` | integer | days since the subject's first `acq_time` | as above |
| `session_count` | integer | number of sessions | – |
| `span_days` | integer | last minus first relative day | chronology unknown |
| `modality_set` | keyword | union of session modalities | – |
| `modality_session_counts[]` | nested | sessions per modality | – |
| `metadata_flags.has_*` | boolean | age, sex, full session timing, any modality present | – |
| `linkage.token`, `.token_version` | keyword | `HMAC-SHA256(FAIRMBIDS_LINKAGE_SECRET, GSId)` | no GSId, or linkage disabled |

Raw GSId values are never indexed, and `linkage` is never returned by any query. Session labels
never imply order: `ses-02` can be the first session.

## API

### `fairMBidsSubjects(filter, first, after, facets)`

It returns subjects of datasets the caller can read: public datasets, datasets with a permission
record for the user, or all datasets for admins. This restriction is part of the Elasticsearch
query, so counts and facets never include unreadable subjects. Results are sorted by `subject_key`
and paged with `search_after` cursors (the same cursor format as `advancedSearch`).

All conditions in one filter must hold for the same subject. `and`, `or` and `not` combine filters.

```graphql
query {
  fairMBidsSubjects(
    filter: {
      subject: { sex: ["F"], age: { gte: 18, lte: 35 } }
      longitudinal: { minSessions: 2 }
      multimodal: { sameSessionAll: ["anat", "eeg"] }
    }
    first: 25
    facets: true
  ) {
    edges { node { subjectKey datasetId participantId sessionCount spanDays
                   sessions { sessionId sessionOrder relativeTimeDays modalities } } }
    pageInfo { count endCursor hasNextPage }
    facets { modalities { value count } sessionCounts { value count } }
  }
}
```

Modality values are the `modality` values in `identifiers.tsv` (for example `anat`, `eeg`,
`ieeg`, `func`), matched case-insensitively.

### `fairMBidsLinkedSubjects(datasetIds, minDatasets, modalitiesAll, first, after)`

This query is admin only, and disabled unless `FAIRMBIDS_LINKAGE_SECRET` is set. It returns
groups of dataset-local subjects that share a GSId. Each group gets a random `linkedSubjectRef`
that is valid only within the response; cursors are encrypted; each call logs an audit line
without identifiers. Read permission on two datasets does not imply linkage permission, and
OpenNeuro has no separate linkage capability, so the query is restricted to admins.

## Query traceability (Stage 2 catalog)

| ID | Filter | Status | Notes |
| --- | --- | --- | --- |
| Q1 | `longitudinal.minSessions` | Done | `session_count` |
| Q2 | `longitudinal.minSpanDays` | Done | timed subjects only |
| Q3 | `longitudinal.hasSessions` with `order` or `sessionId` | Partial | Stage 1 has no `timepoint_role`; "baseline" = `order: {lte: 1}` from `acq_time` |
| Q4 | `longitudinal.transition` | Done | inner hits checked per session pair; `count` is null for this filter |
| Q5 | `hasSessions` + `missingSessions` | Done | "missing" is relative to the predicate; expected-visit metadata does not exist |
| Q6 | `repeatedModality` | Done | `modality_session_counts` |
| Q7 | `multimodal.anywhereAll` | Done | root `modality_set` |
| Q8 | `multimodal.sameSessionAll` | Done | one nested session |
| Q9 | `multimodal.distinctSessions` | Done | exactly two modalities, evaluated without post-processing |
| Q10 | `multimodal.everySessionAll` | Done | rejects any session lacking a modality |
| Q11 | – | **Blocked** | needs acquisition parameters, which Stage 1 does not extract |
| Q12 | – | **Blocked** | as Q11 (PET tracer per acquisition) |
| Q13 | `fairMBidsLinkedSubjects` | Done | admin only, behind the linkage secret |
| Q14 | – | **Blocked** | needs a cross-dataset time anchor; the report requires returning unsupported |
| Q15 | `fairMBidsLinkedSubjects(modalitiesAll)` | Done | |
| Q16 | `subject` + `longitudinal` + `multimodal` | Done | `groups` (`participants.tsv` `group`) instead of the report's `diagnoses` |
| Q17 | `completeness.required` | Done | `AGE`, `SEX`, `SESSION_TIME`, `MODALITY` |
| Q18 | `facets: true` | Done | subject counts by modality, sex, group and session count; not combinable with `transition` |

Other differences from the report:
- Results are paged with `search_after`, without point-in-time.
- `hasSession`/`missingSession`/`sequence` are the lists `hasSessions`/`missingSessions`.
- `facets` is a boolean rather than an enum list.

## Configuration, migration and rollback

- **Enable:** deploy, then run the indexer once. It creates the hash-named index, indexes all
  datasets and moves the `fairmbids-subjects` alias. Until then `fairMBidsSubjects` returns an
  index-not-found error, as `advancedSearch` does before its first indexer run.
- **Linkage:** set `FAIRMBIDS_LINKAGE_SECRET` in `config.env` for both the server and the indexer.
  Changing the secret invalidates all tokens, so reindex afterwards (`token_version` is `v1`).
- **Mapping change:** a new mapping gets a new physical index. The old one stays readable until
  the indexer moves the alias.
- **Rollback:** revert the Stage 3 commits, then delete the `fairmbids-subjects` alias and the
  `fairmbids-subjects-*` indices. The `datasets` index and all dataset data are untouched.

## Verification (2026-10-26)

Unit tests (vitest):
- `fairmbids.spec.ts`: 9, for document building
- `build-fairmbids-search-query.spec.ts`: 12, for the query compiler
- `fairmbids-search.spec.ts`: 5, for authorization, linkage gating and cursor sealing

Live checks ran against the deployment (Elasticsearch 8.18.2, single node, 2 GB) through the
GraphQL API. The data was five datasets indexed by the real indexing code:
- three synthetic fixtures: longitudinal, private cross-link, and legacy
- subsets of OpenNeuro ds005795 (EEG + T1w, no sessions) and ds002799 (pre/post-operative
  sessions, anat + iEEG, no session times)

29 of 29 query, authorization, pagination, linkage and leak checks passed, including:
- a label-order trap
- different-session-only modalities rejected by same-session queries
- private subjects excluded from hits, counts and facets
- no GSId or token in any response

Lifecycle checks also passed: permitted private access, stale-subject removal, and idempotent
re-indexing.

Measured on 11 subject documents (warm, end to end through GraphQL, 20 runs):

| Query | Median | p95 |
| --- | --- | --- |
| Root modality filter | 11.9 ms | 16.3 ms |
| Nested same-session filter | 12.4 ms | 15.4 ms |
| Transition | 20.7 ms | 30.6 ms |

Indexing took 8–128 ms per dataset. Behaviour at production scale (many subjects and sessions)
has not been measured.

Not tested end to end: upload and snapshot creation. This deployment has no S3 bucket configured,
and the datalad service needs one to create any dataset.
