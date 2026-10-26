# FAIR m-BIDS (Stage 1)

fmbids-openneuro accepts datasets that carry [FAIR m-BIDS](https://doi.org/10.1038/s41597-026-06790-7)
identifiers (Mirhosseini et al., *Scientific Data* 13:555, 2026). FAIR m-BIDS extends BIDS
with three identifiers so that files, subjects and datasets can be linked across modalities
and studies. **None of these fields are part of the official BIDS specification.**

Stage 1 only covers storage and validation. Querying (Stage 2) and search indexing (Stage 3)
are not implemented yet.

## Sources

1. The FAIR m-BIDS paper (above).
2. The reference template, ID generator and example dataset at
   [FAIR-mBIDS/FAIR-mBIDS](https://github.com/FAIR-mBIDS/FAIR-mBIDS).
3. The project proposal "Design and Development of a FAIR-mBIDS-Based Open Brain Mapping
   Data Platform".

Conflicts between the sources:

- The paper places `identifiers.tsv` both "within the dataset's metadata folder" and
  "at the dataset root". The reference example uses the root, so the root is what is accepted.
- Identifier formats differ between the paper (`GDId-006525`), the example dataset
  (`GDId_ds005795`, `GUId_…`) and the generator script (`guid_…`, `gs_…`). The paper states
  that formats are platform-defined, so no format is enforced.

## Identifiers

| Field | Level | Where | Meaning | Origin |
| --- | --- | --- | --- | --- |
| `GUId-Key` | file | `identifiers.tsv`, `sub-*_scans.tsv` | Global Unique Identifier Key. Irreversible, fully anonymized. | FAIR m-BIDS paper |
| `GSId` | subject | `participants.tsv`, `identifiers.tsv`, `sub-*_scans.tsv` | Global Unique Subject Identifier. Pseudonymized; re-linkable only through a separately governed mapping that is never part of the dataset. | FAIR m-BIDS paper |
| `GDId` | dataset | `dataset_description.json`, `identifiers.tsv`, `sub-*_scans.tsv` | Global Dataset Identifier. Persistent; may be derived from the accession number (`ds006525` → `GDId-006525`). | FAIR m-BIDS paper |
| `modality` | file | `identifiers.tsv` | Modality of the file, e.g. `anat`, `eeg`, `func`. | FAIR m-BIDS paper |
| `file_path` | file | `identifiers.tsv` | Path of the file relative to the dataset root. | FAIR m-BIDS paper |

Sessions, acquisition times and participant attributes stay in standard BIDS: `ses-<label>`
directories, `sessions.tsv`, the `acq_time` column of `scans.tsv` and `participants.tsv`.
Dataset snapshots (versions) are not sessions; longitudinal visits are only expressed with `ses-*`.

## Validation

The extended validator schema (`schema-1.2.7-datacite.json`, shared by the app, CLI and
datalad service) adds:

- `identifiers.tsv` (and an optional `identifiers.json` sidecar) as an optional root file.
- A table rule for `identifiers.tsv`: all five columns are required, `GUId-Key` must be the
  first column and unique, and extra columns are allowed.

Everything else needs no schema change. Extra columns in `participants.tsv` and `scans.tsv`
are already allowed (a warning asks for a sidecar description when they are undefined), and
`GDId` in `dataset_description.json` produces no issue.

| Dataset | Result |
| --- | --- |
| Without FAIR m-BIDS files | Unchanged |
| Valid `identifiers.tsv`, `GDId`, `GSId` column | No new issues |
| `identifiers.tsv` missing a column | `TSV_COLUMN_MISSING` error |
| Duplicate `GUId-Key` | `TSV_INDEX_VALUE_NOT_UNIQUE` error |

Not validated: whether `file_path` points to an existing file, whether `GSId` values agree
between `identifiers.tsv`, `participants.tsv` and `scans.tsv`, and whether `GDId` agrees with
`dataset_description.json`. These consistency checks are left for Stage 2.

## Privacy

- Only pseudonymous identifiers are stored. The GSId-to-person mapping must never be uploaded.
- fmbids-openneuro never infers that two subjects are the same person, for example from
  matching `sub-<label>` values. A cross-dataset link exists only when an uploader assigns the
  same `GSId` in both datasets.
- The identifier files follow the dataset's existing access controls, like any other file.

## Examples

### A. Legacy dataset

An ordinary BIDS dataset with no FAIR m-BIDS files validates and behaves exactly as before.

```
ds-a/
├── dataset_description.json
├── participants.tsv
└── sub-01/anat/sub-01_T1w.nii.gz
```

### B. Multimodal, same session

```
ds-b/
├── dataset_description.json      {"Name": "...", "BIDSVersion": "1.10.0", "GDId": "GDId-000002"}
├── participants.tsv
├── identifiers.tsv
└── sub-01/ses-01/
    ├── anat/sub-01_ses-01_T1w.nii.gz
    └── eeg/sub-01_ses-01_task-rest_eeg.edf
```

`participants.tsv`

```
participant_id	GSId	age
sub-01	GSId_1a2b3c4d5e6	30
```

`identifiers.tsv`

```
GUId-Key	GSId	GDId	modality	file_path
GUId_9f2c41d07b6a5e8f3c1d2b4a	GSId_1a2b3c4d5e6	GDId-000002	anat	sub-01/ses-01/anat/sub-01_ses-01_T1w.nii.gz
GUId_4b7e0a19c3d82f6e5a1b9c0d	GSId_1a2b3c4d5e6	GDId-000002	eeg	sub-01/ses-01/eeg/sub-01_ses-01_task-rest_eeg.edf
```

### C. Longitudinal

There is one subject with two visits. The visit order and times come from standard BIDS
`sub-01_sessions.tsv` (`session_id`, `acq_time`). Each file gets its own `GUId-Key`, and both
visits share one `GSId`.

```
ds-c/
├── identifiers.tsv
└── sub-01/
    ├── sub-01_sessions.tsv
    ├── ses-baseline/anat/sub-01_ses-baseline_T1w.nii.gz
    └── ses-followup/anat/sub-01_ses-followup_T1w.nii.gz
```

### D. Multimodal longitudinal with missing data

`sub-02` has no EEG at follow-up. Missing data is expressed by the absence of rows and files;
no placeholder rows are needed.

```
GUId-Key	GSId	GDId	modality	file_path
GUId_…01	GSId_aaaaaaaaaaa	GDId-000004	anat	sub-01/ses-baseline/anat/sub-01_ses-baseline_T1w.nii.gz
GUId_…02	GSId_aaaaaaaaaaa	GDId-000004	eeg	sub-01/ses-baseline/eeg/sub-01_ses-baseline_task-rest_eeg.edf
GUId_…03	GSId_aaaaaaaaaaa	GDId-000004	anat	sub-01/ses-followup/anat/sub-01_ses-followup_T1w.nii.gz
GUId_…04	GSId_aaaaaaaaaaa	GDId-000004	eeg	sub-01/ses-followup/eeg/sub-01_ses-followup_task-rest_eeg.edf
GUId_…05	GSId_bbbbbbbbbbb	GDId-000004	anat	sub-02/ses-baseline/anat/sub-02_ses-baseline_T1w.nii.gz
GUId_…06	GSId_bbbbbbbbbbb	GDId-000004	eeg	sub-02/ses-baseline/eeg/sub-02_ses-baseline_task-rest_eeg.edf
GUId_…07	GSId_bbbbbbbbbbb	GDId-000004	anat	sub-02/ses-followup/anat/sub-02_ses-followup_T1w.nii.gz
```

### E. Authorized cross-dataset linkage

The same person is `sub-07` in dataset `GDId-000005` and `sub-03` in dataset `GDId-000006`.
The governed mapping assigns both rows the same `GSId`, which is the only link between them.

```
# GDId-000005 participants.tsv
participant_id	GSId
sub-07	GSId_c3d4e5f6a7b

# GDId-000006 participants.tsv
participant_id	GSId
sub-03	GSId_c3d4e5f6a7b
```

## Query capability matrix (Stage 2 input)

| Question | Required data |
| --- | --- |
| Participants with both EEG and MRI | `identifiers.tsv` rows grouped by `GSId`, set of `modality` |
| Both modalities in the same session | rows grouped by (`GSId`, `ses-` entity of `file_path`) |
| At least three longitudinal sessions | count of distinct `ses-` entities per `GSId` |
| MRI at baseline and EEG at follow-up | session order from `sessions.tsv` `acq_time` (or the session label), joined to the `modality` of each row |
| Sessions missing a required modality | expected modality set compared with the modalities per (`GSId`, session) |
| Complete multimodal longitudinal coverage | the two rows above, applied across all sessions |
| Same participant across datasets | rows from several `GDId`s sharing one `GSId` |

## Extraction contract (Stage 3 input)

For each dataset snapshot that contains `identifiers.tsv`, the indexer should produce one
record per row. Each record carries the five columns as written, plus fields derived from
`file_path` with the BIDS entity rules: `subject` (`sub-` label), `session` (`ses-` label or
null) and `datatype` (the parent directory). It also carries `acq_time` from the matching
`scans.tsv` row when present, the dataset `GDId` from `dataset_description.json`, and the
snapshot tag. Snapshots without `identifiers.tsv` produce no records, so the existing indexing
of such datasets is unaffected.

## Open decisions

- The identifier format and the GUId-Key allocation approach (the paper describes Top-Down and
  Bottom-Up) are governance decisions for the platform.
- Whether fmbids-openneuro should generate identifiers on upload, or only accept identifiers
  that uploaders provide (the current behaviour).
- Storage and access control for the GSId re-linking mapping.

## Rollback

All Stage 1 changes are additions to the validator schema. Reverting those commits restores
the previous behaviour; datasets that already contain `identifiers.tsv` will then report
`NOT_INCLUDED` again, but no data is changed.
