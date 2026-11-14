# Data Import Readiness

> **State reconciliation (2026-11-10):** This document began as a pre-import
> review. The later V1 acceptance record reports that Production contains 586
> branches and 1,992 scanners. Treat the older “no records imported” statements
> below as historical. Do not repeat the initial import. The seven source
> address/branch conflict cases still require checking against the exact source
> workbook selected for any future import; this note does not claim that the
> original workbook was edited.

## Source review

The source review below is a dated, read-only snapshot of
`Data_Branch_AIS_แยกที่อยู่.xlsx`. Its field observations remain useful, but its
initial import status was superseded by the later Production import recorded in
`v1-release-acceptance.md`.

- `Detail1`: 1,992 device rows, 20 columns, 580 distinct non-empty `LocationCode` values.
- All 1,992 rows have a non-empty, unique `comSN` and `comID` after trimming outer whitespace.
- 536 codes have multiple scanner rows; this is valid because one branch can contain multiple devices. The maximum in this file is 19 devices for one code.
- `postal_code` is blank on 37 rows and `subdistrict` on 64 rows. Both fields are nullable in the current schema.
- The `Pivot` sheet independently lists the name variants below with matching row counts.
- The other sheets contain pivots and planning data. The proposed import source remains `Detail1` only.

## Branch identity conflicts

The workbook contains 586 distinct normalized (`LocationCode`, `locBld`) pairs, not 580. Six codes therefore have more than one source branch label. Importing by `LocationCode` alone would either merge different labels or reject valid device rows.

| LocationCode | Detail1 rows | `locBld` variants and row counts | Additional difference |
| --- | --- | --- | --- |
| 1111 | 544–554 | `1111 The Mall บางกะปิ` (9); `The Mall บางกะปิ สาขา 2` (2) | Address also differs |
| 1115 | 567–574 | `1115 Central พระราม 3` (4); `1115 Central พระราม 3 สาขา 2` (4) | — |
| 1207 | 865–877 | `1207 Central ศรีราชา (Sriracha Chonburi)` (1); `1207 Robinson ศรีราชา (Pacific Park)` (12) | — |
| 2522 | 1522–1524 | `2522 ธีระรัตน์ ถ.กลางเมือง ขอนแก่น` (1); `2522 Big C อ.กระนวน จ.ขอนแก่น` (2) | — |
| 2528 | 1529–1531 | `2528 Lotus ขอนแก่น 1` (2); `2528 Big C ขอนแก่น` (1) | — |
| 97537 | 1934–1936 | `97537 อ.แม่สาย เชียงราย` (2); `97537 หจก.ฟิวเจอร์เวิร์ล (ประเทศไทย) สาขาแม่สาย เชียงราย` (1) | — |
| 32056 | 1704–1705 | `32056 Lotus ท่าตูม จ.สุรินทร์` (2) | Address differs only by spacing |

The database migration now permits a branch key of `LocationCode + normalized locBld`; it has been applied to the connected production project, whose branch and scanner registers were empty at the time. The scanner-list RPC also returns the scanner UUID, so multiple assets under the same code receive stable UI row keys. The near-identical address text for 32056 is whitespace-normalized during import.

## Import mapping

- Branch: `LocationCode`, `subsZn`, `locBld`, address, province, district, subdistrict, postal code, `RO`, `HighLevelLocation`.
- Scanner: `hwName`, brand, model name, `comID`, `comSN`, model ID, `comYrs`.
- `empMail`, contact type, and free-text note are not needed by the current schema and should not be imported.

The application now has an `.xlsx` reader for the `Detail1` sheet, a server-side staging/validation RPC, and a one-time atomic commit RPC. The actual workbook was parsed locally and returned 1,992 rows with the expected 17 approved fields; email, installation/contact type, and free-text notes are excluded. Local Auth/API and pgTAP tests pass. The production staging/commit migration is applied and the import UI is deployed to Cloudflare. Public HTML, JavaScript, and CSS return HTTP 200 with the expected build filenames. The user completed the authenticated browser import. Production verification found one committed batch with 1,992 rows and zero validation issues, creating 586 branches and 1,992 scanners.

The commit RPC is deliberately bootstrap-only: it refuses to commit if the branch or scanner register already contains any rows. Importing a corrected or incremental workbook will need a separately reviewed update workflow rather than reusing this initial-load operation.

## What “not using Excel” means

The workbook is the one-time source file for checking and importing the existing records. It is not the long-term place to operate the system: once a validated import flow exists, the records will live in Cloudflare D1 and staff will view or update them in the web application. This review has not imported the workbook or changed its contents.
