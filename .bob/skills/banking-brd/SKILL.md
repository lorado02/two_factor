---
name: banking-brd
description: Use when the user wants to create, write, or generate a BRD (Business Requirements Document) for a banking or financial application. Auto-activates on phrases like "write a BRD", "create a BRD", "generate a business requirements document", or "draft a BRD".
---

# Banking BRD Generator

Follow these steps to produce a well-structured Business Requirements Document for a banking application.

## Step 1 — Gather Context

Use `ask_followup_question` to collect the minimum inputs needed:

1. **Feature / initiative name** — what is being built or changed?
2. **Source material** — does the user have a requirements file, notes, or a summary to paste in? If yes, read it with `read_file`.
3. **Audience** — internal stakeholders, regulator submission, vendor RFP, or all three?
4. **Regulatory scope** — which rules apply (RBI, PCI-DSS, ISO 27001, GDPR, DPDP, etc.)?

If the active file already contains requirements context (check `<active_file>` in environment), read it first and skip asking questions that are already answered.

## Step 2 — Produce the BRD

Write the document using `write_file` to a path the user specifies (default: `BRD_<feature-name>.md` in the workspace root).

Use **exactly** the section structure below. Do not add extra top-level sections unless the user explicitly asks for them. Keep each section tight — bullet points over prose wherever possible.

---

### BRD Structure

```
# Business Requirements Document
## <Feature / Initiative Name>

| Field            | Value                          |
|------------------|-------------------------------|
| Document ID      | BRD-<XXX>                     |
| Version          | 1.0 — Draft                   |
| Date             | <today's date>                |
| Author           | <leave blank for user to fill>|
| Status           | Draft / Under Review / Approved|
| Regulatory Scope | <list applicable frameworks>  |

---

## 1. Executive Summary
Two-to-four sentences: what is changing, why it matters, and what success looks like.

---

## 2. Business Case
- **Problem statement** — current state pain, quantified where possible (incidents, costs, audit findings).
- **Strategic alignment** — which OKR, regulatory requirement, or partnership gate this closes.
- **Expected benefit** — target metrics (e.g. ≥80 % reduction in account-takeover cases).

---

## 3. Scope
### 3.1 In Scope
Bulleted list of channels, systems, and workflows covered.

### 3.2 Out of Scope
Explicit exclusions to prevent scope creep.

---

## 4. Stakeholders

| Role                | Name / Team          | Interest / Responsibility        |
|---------------------|----------------------|----------------------------------|
| Business Owner      |                      |                                  |
| Product Manager     |                      |                                  |
| Compliance / Risk   |                      |                                  |
| IT / Engineering    |                      |                                  |
| Operations          |                      |                                  |
| External (Regulator)|                      | Audit / compliance sign-off      |

---

## 5. Business Requirements

Number every requirement `BR-XXX`. Use the following table format:

| ID     | Requirement                                         | Priority | Source / Rule        |
|--------|-----------------------------------------------------|----------|----------------------|
| BR-001 | <Plain-English statement of what the system shall do> | Must    | RBI / Internal Audit |
| BR-002 | ...                                                 | Should   |                      |

Priority values: **Must** (mandatory / regulatory), **Should** (strong business need), **Could** (desirable).

---

## 6. Functional Requirements Summary
High-level capabilities the solution must deliver, grouped by theme (e.g. Authentication, Notifications, Admin / Ops Tooling). Keep to bullet points — detailed specs belong in a downstream FSD.

---

## 7. Non-Functional Requirements

| Category        | Requirement                                                  |
|-----------------|--------------------------------------------------------------|
| Security        | e.g. OTP valid for ≤ 5 minutes, encrypted in transit (TLS 1.2+) |
| Availability    | e.g. 99.9 % uptime during banking hours                      |
| Performance     | e.g. OTP delivery ≤ 10 seconds at P95                        |
| Compliance      | e.g. RBI Master Directions, PCI-DSS v4, ISO 27001            |
| Accessibility   | e.g. WCAG 2.1 AA for web channel                             |
| Data Retention  | e.g. Audit logs retained for 5 years per RBI mandate         |

---

## 8. Assumptions & Dependencies
- **Assumptions** — things believed to be true that, if wrong, change scope or cost.
- **Dependencies** — external systems, vendor SLAs, regulatory approvals, or parallel projects this relies on.

---

## 9. Constraints
Regulatory deadlines, technology standards, budget caps, or contractual obligations that bound the solution.

---

## 10. Acceptance Criteria
How will the business confirm the requirements have been met? Link each criterion back to a `BR-XXX` where possible.

| AC-ID  | Criterion                                                         | Linked BR  |
|--------|-------------------------------------------------------------------|------------|
| AC-001 |                                                                   | BR-001     |

---

## 11. Open Issues / Decisions Log

| ID    | Issue / Decision Needed              | Owner | Target Date | Status |
|-------|--------------------------------------|-------|-------------|--------|
| OI-001|                                      |       |             | Open   |

---

## 12. Document History

| Version | Date | Author | Change Summary |
|---------|------|--------|----------------|
| 1.0     | <date> |      | Initial draft  |

---
*End of Document*
```

## Step 3 — Populate from Source Material

After writing the skeleton, go back through and fill in every section using information from:
- The source requirement file (read with `read_file` if provided)
- Answers from Step 1
- Reasonable banking-domain defaults (e.g. standard RBI compliance language)

Leave explicit `<!-- TODO: -->` comments only for fields that genuinely require human input (names, sign-off dates, budget figures).

## Step 4 — Confirm Output

Tell the user:
- The file path where the BRD was written
- How many `<!-- TODO: -->` placeholders need their attention
- The next logical step (e.g. share with stakeholders for review, or proceed to FSD)
