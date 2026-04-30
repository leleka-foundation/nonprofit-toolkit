import type {
  Finding,
  SourceCredentialField,
  SourceManualEvidenceField,
} from '../types/index.ts'
import type { DiscoveryReport, DiscoveryRun } from './discover.ts'

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  error: 0,
  warn: 1,
  info: 2,
}

export function isDiscoveryComplete(report: DiscoveryReport): boolean {
  return (
    report.runs.length > 0 &&
    report.runs.every((run) => run.outcome.status === 'success') &&
    report.findings.every((finding) => finding.severity === 'info')
  )
}

export function formatDiscoveryReport(report: DiscoveryReport): string {
  const lines: string[] = [
    `# Compliance Discovery: ${report.entity.legal_name}`,
    '',
    `Status: ${isDiscoveryComplete(report) ? 'complete' : 'incomplete'}`,
  ]
  const actionRequired = formatActionRequired(report.runs)
  if (actionRequired.length > 0) {
    lines.push('', ...actionRequired)
  }
  lines.push(
    '',
    '## Source Runs',
    ...sortRuns(report.runs).map(formatRun),
    '',
    '## Findings',
    ...formatFindings(report.findings),
  )

  if (
    report.migration.createdDataset ||
    report.migration.createdTables.length > 0 ||
    report.migration.addedColumns.length > 0
  ) {
    lines.push(
      '',
      'Compliance storage was provisioned or migrated during this run.',
    )
  }

  return `${lines.join('\n')}\n`
}

type ManualRequiredRun = DiscoveryRun & {
  readonly outcome: Extract<
    DiscoveryRun['outcome'],
    { readonly status: 'manual_required' }
  >
}

type AuthRequiredRun = DiscoveryRun & {
  readonly outcome: Extract<
    DiscoveryRun['outcome'],
    { readonly status: 'auth_required' }
  >
}

function sortRuns(runs: readonly DiscoveryRun[]): DiscoveryRun[] {
  return runs
    .slice()
    .sort(
      (left, right) =>
        left.jurisdictionId.localeCompare(right.jurisdictionId) ||
        left.sourceId.localeCompare(right.sourceId),
    )
}

function formatActionRequired(runs: readonly DiscoveryRun[]): string[] {
  const sortedRuns = sortRuns(runs)
  const manualRuns = sortedRuns.filter(isManualRequiredRun)
  const authRuns = sortedRuns.filter(isAuthRequiredRun)
  if (manualRuns.length === 0 && authRuns.length === 0) {
    return []
  }

  const lines: string[] = [
    '## Action Required',
    'Discovery is incomplete until these manual or authenticated checks are completed.',
  ]
  if (manualRuns.length > 0) {
    lines.push('', 'Manual checks:', ...manualRuns.map(formatManualActionItem))
  }
  if (authRuns.length > 0) {
    lines.push(
      '',
      'Authenticated checks:',
      'Sign in yourself with an authorized account and complete MFA yourself.',
      ...authRuns.map(formatAuthActionItem),
      'Do not paste passwords, MFA codes, backup codes, or session cookies into chat.',
    )
  }
  lines.push(
    '',
    'Reply with one evidence block per source using the field keys exactly as shown below.',
    ...manualRuns.flatMap(formatActionReplyBlock),
    ...authRuns.flatMap(formatActionReplyBlock),
  )
  return lines
}

function isManualRequiredRun(run: DiscoveryRun): run is ManualRequiredRun {
  return run.outcome.status === 'manual_required'
}

function isAuthRequiredRun(run: DiscoveryRun): run is AuthRequiredRun {
  return run.outcome.status === 'auth_required'
}

function formatManualActionItem(run: ManualRequiredRun): string {
  const label = `${run.jurisdictionId}/${run.sourceId}`
  return `- Complete manual check \`${label}\`: open ${run.accessUrl} and return ${formatFieldKeys(
    run.outcome.evidenceFields,
  )}.`
}

function formatAuthActionItem(run: AuthRequiredRun): string {
  const label = `${run.jurisdictionId}/${run.sourceId}`
  const loginUrl = run.outcome.loginUrl ?? run.accessUrl
  return `- Complete authenticated check \`${label}\`: sign in at ${loginUrl} and return ${formatOptionalFieldKeys(
    run.outcome.evidenceFields,
  )}.`
}

function formatFieldKeys(fields: readonly SourceManualEvidenceField[]): string {
  return fields.map((field) => `\`${field.key}\``).join(', ')
}

function formatOptionalFieldKeys(
  fields: readonly SourceManualEvidenceField[] | undefined,
): string {
  if (fields === undefined || fields.length === 0) {
    return 'the evidence fields printed in the source-run details'
  }
  return formatFieldKeys(fields)
}

function formatActionReplyBlock(
  run: ManualRequiredRun | AuthRequiredRun,
): string[] {
  const label = `${run.jurisdictionId}/${run.sourceId}`
  if (isManualRequiredRun(run)) {
    return [
      `source: ${label}`,
      ...run.outcome.evidenceFields.map(formatReplyField),
    ]
  }
  const fields = run.outcome.evidenceFields
  if (fields === undefined) {
    return [`source: ${label}`]
  }
  return [`source: ${label}`, ...fields.map(formatReplyField)]
}

function formatRun(run: DiscoveryRun): string {
  const label = `${run.jurisdictionId}/${run.sourceId}`
  const outcome = run.outcome
  if (outcome.status === 'success') {
    return `- OK ${label}: success`
  }
  if (outcome.status === 'manual_required') {
    return formatManualRun(label, run, outcome)
  }
  if (outcome.status === 'policy_blocked') {
    return `- BLOCKED ${label}: ${outcome.reason}`
  }
  if (outcome.status === 'auth_required') {
    return formatAuthRun(label, run, outcome)
  }
  return `- ERROR ${label}: failed (${outcome.error_type}) ${outcome.message}`
}

function formatManualRun(
  label: string,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'manual_required' }>,
): string {
  return [
    `- MANUAL ${label}: manual verification required`,
    `  Why automatic scan is unavailable: ${formatManualOnlyReason(run)}`,
    `  Open manually: ${run.accessUrl}`,
    `  Source terms reviewed: ${run.tosUrl}`,
    '  Manual steps:',
    ...outcome.instructions.map(
      (instruction, index) => `  ${index + 1}. ${instruction}`,
    ),
    '  Give these values back to the compliance-discover skill:',
    ...outcome.evidenceFields.map(formatEvidenceField),
    '  Suggested reply format:',
    `  source: ${label}`,
    ...outcome.evidenceFields.map(formatReplyField),
  ].join('\n')
}

function formatManualOnlyReason(run: DiscoveryRun): string {
  if (run.manualOnlyReason === undefined) {
    return 'No manual-only reason was captured for this source.'
  }
  return run.manualOnlyReason
}

function formatEvidenceField(field: SourceManualEvidenceField): string {
  const requirement = field.required ? 'required' : 'optional'
  return `  - ${field.key} (${requirement}): ${field.label}`
}

function formatReplyField(field: SourceManualEvidenceField): string {
  return `  ${field.key}: <${field.label}>`
}

function formatAuthRun(
  label: string,
  run: DiscoveryRun,
  outcome: Extract<DiscoveryRun['outcome'], { status: 'auth_required' }>,
): string {
  if (
    outcome.loginUrl === undefined ||
    outcome.credentialMode === undefined ||
    outcome.credentialFields === undefined ||
    outcome.mfa === undefined ||
    outcome.instructions === undefined ||
    outcome.evidenceFields === undefined ||
    outcome.forbiddenActions === undefined
  ) {
    return `- AUTH ${label}: ${outcome.message}`
  }

  return [
    `- AUTH ${label}: authenticated verification required`,
    `  ${outcome.message}`,
    `  Login URL: ${outcome.loginUrl}`,
    `  Source terms reviewed: ${run.tosUrl}`,
    `  Credential/session mode: ${outcome.credentialMode}`,
    `  MFA: ${outcome.mfa}`,
    '  Auth/setup steps:',
    ...outcome.instructions.map(
      (instruction, index) => `  ${index + 1}. ${instruction}`,
    ),
    '  Credential/session fields:',
    ...outcome.credentialFields.map(formatCredentialField),
    '  Give these values back to the compliance-discover skill:',
    ...outcome.evidenceFields.map(formatEvidenceField),
    '  Suggested reply format:',
    `  source: ${label}`,
    ...outcome.evidenceFields.map(formatReplyField),
    '  Forbidden actions:',
    ...outcome.forbiddenActions.map(
      (action, index) => `  ${index + 1}. ${action}`,
    ),
  ].join('\n')
}

function formatCredentialField(field: SourceCredentialField): string {
  const requirement = field.required ? 'required' : 'optional'
  const secrecy = field.secret ? 'secret' : 'non-secret'
  return `  - ${field.key} (${requirement}, ${secrecy}): ${field.label}`
}

function formatFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) {
    return ['- None.']
  }

  return findings.slice().sort(compareFindings).map(formatFinding)
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.jurisdiction_id.localeCompare(right.jurisdiction_id) ||
    left.source_id.localeCompare(right.source_id) ||
    left.title.localeCompare(right.title)
  )
}

function formatFinding(finding: Finding): string {
  return `- ${finding.severity.toUpperCase()} ${finding.jurisdiction_id}/${finding.source_id}: ${finding.title} - ${finding.detail}`
}
