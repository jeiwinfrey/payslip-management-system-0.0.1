import type { SpreadsheetColumnDef } from "@/components/dashboard/spreadsheet/column-defs/types"
import { PAYSLIP_FIELD_SECTIONS } from "@/lib/spreadsheet/payslips"
import { DERIVED_PAYSLIP_FIELD_KEYS } from "@/lib/payroll-calculator"
import type { PayslipFieldDefinition } from "@/lib/payslip-fields"

const derivedFields = new Set<string>(DERIVED_PAYSLIP_FIELD_KEYS)

// ponytail: unit hint in spreadsheet column headers so admins know the unit at a glance.
function headerLabel(field: PayslipFieldDefinition): string {
  if (field.inputKind === "peso" || /\(.*\)/.test(field.label)) return field.label
  return field.inputKind === "hours" ? `${field.label} (hrs)` : `${field.label} (days)`
}

function formatAmount(value: unknown) {
  const amount = Number(value ?? 0)
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00"
}

const numericColumn = (field: string, headerName: string): SpreadsheetColumnDef => ({
  field,
  headerName,
  type: derivedFields.has(field) ? "readonly" : "number",
  minWidth: 110,
  format: formatAmount,
})

const totalColumn = (field: string, headerName: string): SpreadsheetColumnDef => ({
  field,
  headerName,
  type: "readonly",
  minWidth: 130,
  pinned: "right",
  format: formatAmount,
})

export const payslipColumns: SpreadsheetColumnDef[] = [
  {
    field: "employeeName",
    headerName: "Employee",
    type: "readonly",
    pinned: "left",
    minWidth: 240,
  },
  {
    field: "employeeId",
    headerName: "Employee ID",
    type: "readonly",
    pinned: "left",
    minWidth: 120,
  },
  {
    field: "status",
    headerName: "Status",
    type: "readonly",
    pinned: "left",
    minWidth: 120,
  },
  ...PAYSLIP_FIELD_SECTIONS.flatMap((section) =>
    section.fields.map((field) => numericColumn(field.key, headerLabel(field)))
  ),
  totalColumn("taxableEarnings", "Taxable Earnings"),
  totalColumn("totalDeductions", "Total Deductions"),
  totalColumn("nonTaxableEarnings", "Non-Taxable"),
  totalColumn("grossPay", "Gross Pay"),
  totalColumn("netPay", "Net Pay"),
]
