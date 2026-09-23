import { type LegalDraftSection } from './legal-types';

export const dataProtectionDraft: readonly LegalDraftSection[] = [
  { id: 'application', heading: 'When this schedule applies', paragraphs: [
    'This proposed schedule supplements an executed Awoof merchant or institution agreement. It takes effect only when the parties incorporate its identified version and complete the processing annex. It is not a standalone authorization to access university records, use an identity provider or share personal data.',
    'Personal data, controller and processor have the meanings in applicable data-protection law. The schedule governs personal-data matters where it conflicts with general commercial terms. It does not reduce a person’s statutory rights or a regulator’s powers.',
  ] },
  { id: 'roles', heading: 'Identify the role for each activity', paragraphs: [
    'The parties must record their roles for each processing activity. Awoof may act as controller for its own accounts, account security and verification history; a merchant may act as a separate controller for its checkout and use of a received result; and an institution may control its enrollment records. Those roles must be tested against the actual purposes and decisions of each party.',
    'The processor provisions below apply only to activities where one party processes solely on the other’s documented instructions. Calling a party a processor does not change the facts. If purposes and means are jointly determined, the parties must document the appropriate joint arrangement and user-facing responsibilities before starting that activity.',
  ] },
  { id: 'sharing', heading: 'Controller-to-controller disclosures', paragraphs: [
    'Each controller must establish its lawful basis, provide required notices, collect any required consent and limit the disclosure to the agreed purpose and fields. The recipient must not use a result for unrelated marketing, resale, model training, cross-merchant tracking or another unapproved purpose.',
    'The standard merchant flow uses a scoped identifier and eligibility metadata. An institution connection must state the fields, authority, permitted population, update frequency, evidence expiry and revocation process. A school-account sign-in is not permission to extract a student directory. Any age or special-category data requires a separate necessity and legal assessment.',
    'The parties will communicate material corrections, invalidations or restrictions relevant to the agreed use. The receiving party must assess its own records and obligations; it must not interpret a historical receipt as permanent or fresh eligibility.',
  ] },
  { id: 'instructions', heading: 'Processor instructions and personnel', paragraphs: [
    'For processor activities, the processor may use data only on documented lawful instructions in the agreement, annex and authorized service requests, including instructions about international transfers. It must notify the controller if it believes an instruction is unlawful and suspend the affected instruction while the issue is resolved. If law compels a different use, it must notify the controller where legally permitted.',
    'Only authorized personnel who need access may handle the data. They must be subject to confidentiality duties and appropriate training. The processor must not acquire independent advertising, resale or model-training rights in the data through this schedule.',
  ] },
  { id: 'security', heading: 'Agreed security measures', paragraphs: [
    'The parties must adopt measures appropriate to the data and risks and record them in the security annex before activation. Required topics include access control, credential handling, protected transmission, storage protection appropriate to the system, tenant separation, audit logging, vulnerability management, backup and recovery, and secure disposal.',
    'The annex must distinguish a verified implemented measure from a planned improvement. It must not claim a certification, independent audit, universal encryption coverage or tested recovery objective without evidence. Material reductions in agreed protection require notice and resolution before the affected processing continues.',
  ] },
  { id: 'providers', heading: 'Subprocessors and onward recipients', paragraphs: [
    'A processor must obtain the controller’s prior specific or general written authorization before appointing a subprocessor. The annex must list each authorized subprocessor, function and location. Under general authorization, planned changes require advance notice sufficient for a reasoned data-protection objection before access begins.',
    'The parties must resolve a substantiated objection by an appropriate alternative or ending the affected processing. Equivalent relevant obligations must flow down in writing. The appointing processor remains responsible to the controller for its subprocessor’s performance. Separate controllers are identified as such rather than inaccurately listed as subprocessors.',
  ] },
  { id: 'transfers', heading: 'International transfers and location restrictions', paragraphs: [
    'Before a transfer, the responsible party must identify the destination, onward access, applicable transfer basis and any necessary supplementary safeguards. The documented assessment must address the relevant Nigerian requirements and any binding restrictions attached to institutional data. A contract label alone is not proof of adequate protection.',
    'No global access permission or Nigeria-only hosting warranty is implied. A new destination or onward recipient must be assessed and handled under the agreed change procedure. If a lawful basis or required safeguard ceases to apply, the affected transfer must be suspended or corrected.',
  ] },
  { id: 'rights', heading: 'Rights requests, complaints and assessments', paragraphs: [
    'Each controller remains responsible for requests concerning processing it controls. A processor must promptly forward requests and provide reasonable assistance with searches, access, correction, restriction, deletion, portability and decision review. It must not independently reject a request on the controller’s behalf unless instructed or required by law.',
    'The parties must cooperate on relevant impact assessments, regulator inquiries and safeguards for qualifying automated decisions or children. Assistance procedures and any reasonable exceptional costs must not frustrate statutory rights or deadlines.',
  ] },
  { id: 'incidents', heading: 'Personal-data incidents', paragraphs: [
    'A processor must notify the engaging controller upon becoming aware of a personal-data breach, without waiting for a completed investigation. Each party must notify the other without undue delay of an incident affecting shared data so that the responsible party can meet its own legal duties.',
    'Initial notice must give the available nature, affected data and people, likely effects, containment steps and response contact. Missing details may follow in updates. Preserve relevant evidence, cooperate in containment and remediation, and document decisions. Neither party may prevent a notification required by law or make a misleading statement on the other’s behalf.',
    'The incident annex must identify reachable contacts, escalation arrangements and any agreed contractual notification target. Statutory notification requirements continue to apply even when an annex is silent.',
  ] },
  { id: 'retention', heading: 'Retention, return and deletion', paragraphs: [
    'The processing annex must set durations or lawful retention criteria for every category, including backups, consent records and receipts. On completion or termination of processor services, the processor must return or delete the controller’s data as instructed, subject to a documented legal retention requirement, and confirm completion.',
    'Any permitted retained copy must have restricted access and no unrelated use. The annex must state backup expiry and how deletion restrictions will be reapplied after restoration. An immutable audit design is not, by itself, a legal ground to retain identifiable data indefinitely. Controllers separately assess records they lawfully retain for their own purposes.',
  ] },
  { id: 'assurance', heading: 'Evidence, audit and responsibility', paragraphs: [
    'The processor must provide information reasonably needed to demonstrate compliance with this schedule and permit proportionate audits by the controller or its appointed assessor. Use existing relevant evidence where sufficient, protect other customers’ information and coordinate access securely. Notice and confidentiality arrangements must not obstruct a regulator or urgent incident response.',
    'Commercial responsibility between the parties follows the executed agreement, subject to mandatory law. No liability allocation excuses a party from its own statutory duty. A material unresolved failure permits suspension or termination of the affected processing and an orderly return or deletion process.',
  ] },
  { id: 'annex', heading: 'Processing annex to complete before signature', paragraphs: [
    'The following annex is part of the agreement and must be completed for the specific integration. A blank field is not an authorization or a representation that a control exists.',
  ], points: [
    'Parties and roles: legal names, addresses, signatories, controller/processor roles by activity, privacy and incident contacts.',
    'Processing: service and purpose, source authority, people concerned, exact input/output fields, frequency, method, duration and lawful basis; any special-category or children’s data.',
    'Enrollment evidence: institution authority, approved population, freshness, correction, revocation and expiry rules, and consequences of source unavailability.',
    'Recipients and locations: processors, separate controllers, subprocessors, data and backup regions, remote access locations and transfer basis.',
    'Security and rights: verified measures, evidence owner, assessment results, request handling, automated-decision safeguards and incident escalation.',
    'Exit: record-by-record retention, deletion/return format and timetable, backup handling, legal holds, audit evidence and authorized signatures.',
  ] },
];
