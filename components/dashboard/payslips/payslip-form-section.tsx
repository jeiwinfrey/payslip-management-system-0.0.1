"use client"

import { DecimalInput } from "@/components/dashboard/shared/decimal-input"
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { getPayslipFieldMaxLength } from "@/lib/input-limits"
import type { PayslipFieldDefinition } from "@/lib/payslip-fields"
import type { PayslipPayrollInputs } from "@/lib/types"
import { cn } from "@/lib/utils"

type PayslipFormSectionProps = {
  title: string
  fields: PayslipFieldDefinition[]
  values: PayslipPayrollInputs
  fieldDrafts?: Partial<Record<keyof PayslipPayrollInputs, string>>
  readOnlyFields?: ReadonlySet<keyof PayslipPayrollInputs>
  columns?: 2 | 3 | 4
  onChange: (key: keyof PayslipPayrollInputs, value: string) => void
}

const COLUMNS_CLASS: Record<2 | 3 | 4, string> = {
  2: "grid gap-4 sm:grid-cols-2",
  3: "grid gap-4 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid gap-4 sm:grid-cols-2 lg:grid-cols-4",
}

// ponytail: unit suffix shown in form labels so admins know what to enter.
// Skip suffix when the label already contains a unit hint (e.g. "Absences (Days)").
function unitSuffix(field: PayslipFieldDefinition): string {
  if (field.inputKind === "peso") return ""
  if (/\(.*\)/.test(field.label)) return ""
  return field.inputKind === "hours" ? " (hrs)" : " (days)"
}

export function PayslipFormSection({
  title,
  fields,
  values,
  fieldDrafts,
  readOnlyFields,
  columns = 3,
  onChange,
}: PayslipFormSectionProps) {
  return (
    <FieldSet>
      <FieldLegend>{title}</FieldLegend>
      <div className={COLUMNS_CLASS[columns]}>
        {fields.map((field) => {
          const key = field.key as keyof PayslipPayrollInputs
          const value = values[key]
          const draft = fieldDrafts?.[key]
          const isReadOnly = readOnlyFields?.has(key) ?? false
          const displayValue = isReadOnly
            ? String(value)
            : draft !== undefined
              ? draft
              : value === 0
                ? ""
                : String(value)

          return (
            <Field key={field.key}>
              <FieldLabel htmlFor={field.key}>{field.label}{unitSuffix(field)}</FieldLabel>
              <DecimalInput
                id={field.key}
                name={field.key}
                maxLength={getPayslipFieldMaxLength(field.inputKind)}
                value={displayValue}
                readOnly={isReadOnly}
                aria-readonly={isReadOnly}
                className={cn(
                  isReadOnly &&
                    "cursor-not-allowed bg-muted text-muted-foreground"
                )}
                onChange={(event) =>
                  onChange(
                    field.key as keyof PayslipPayrollInputs,
                    event.target.value
                  )
                }
                placeholder="0"
              />
            </Field>
          )
        })}
      </div>
    </FieldSet>
  )
}
