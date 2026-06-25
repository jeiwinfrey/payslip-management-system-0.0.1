"use client"

import * as React from "react"

import type { PayslipFieldDefinition } from "@/lib/payslip-fields"
import {
  DEDUCTION_FIELDS,
  NON_TAXABLE_FIELDS,
  PAY_DETAILS_FIELDS,
} from "@/lib/payslip-fields"
import type { EmployeeDivisor } from "@/lib/employee-options"
import { calculatePayslipTotals, formatAttendanceDuration } from "@/lib/payroll-calculator"
import type {
  PayslipAttendanceDisplay,
  PayslipPayrollInputs,
} from "@/lib/types"
import { cn } from "@/lib/utils"

type PayslipBreakdownProps = {
  inputs: PayslipPayrollInputs
  divisor?: EmployeeDivisor | number
  attendance?: PayslipAttendanceDisplay
  variant?: "default" | "dashboard"
}

type BreakdownSectionKind = "pay" | "deduction" | "nonTaxable"

function formatMoney(value: number, { signed = false } = {}) {
  const absValue = Math.abs(value)
  const formatted = absValue.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  if (!signed || value === 0) {
    return `₱${formatted}`
  }

  return `${value < 0 ? "-" : "+"}₱${formatted}`
}

// ponytail: full-precision format for auditing — shows all decimal places.
function formatMoneyFull(value: number, { signed = false } = {}) {
  const absValue = Math.abs(value)
  const formatted = absValue.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 20,
  })

  if (!signed || value === 0) {
    return `₱${formatted}`
  }

  return `${value < 0 ? "-" : "+"}₱${formatted}`
}

// ponytail: click-to-reveal full precision for audit purposes.
function ClickableAmount({
  value,
  rawValue,
  signed,
  className,
}: {
  value: number
  rawValue?: number
  signed: boolean
  className?: string
}) {
  const [expanded, setExpanded] = React.useState(false)
  const rounded = formatMoney(value, { signed })
  const full = formatMoneyFull(rawValue ?? value, { signed })
  const hasPrecision = rounded !== full

  if (!hasPrecision) {
    return <span className={className}>{rounded}</span>
  }

  return (
    <span
      className={cn(className, "cursor-pointer select-all underline decoration-dotted underline-offset-2")}
      onClick={() => setExpanded((prev) => !prev)}
      title={expanded ? "Click to collapse" : "Click to show full precision"}
    >
      {expanded ? full : rounded}
    </span>
  )
}

function formatQuantity(field: PayslipFieldDefinition, value: number): string {
  switch (field.inputKind) {
    case "hours":
      return `${value.toLocaleString("en-PH", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })} hrs`
    case "days":
      return value === 1 ? "1 day" : `${value} days`
    case "peso":
      return formatMoney(value)
  }
}

function getAmountClassName(value: number) {
  if (value > 0) {
    return "text-emerald-700 dark:text-emerald-400"
  }
  if (value < 0) {
    return "text-red-700 dark:text-red-400"
  }
  return "text-muted-foreground"
}

function getDisplayAmount({
  sectionKind,
  value,
  lineAmount,
}: {
  sectionKind: BreakdownSectionKind
  value: number
  lineAmount?: number
}) {
  if (sectionKind === "pay") {
    return lineAmount ?? value
  }

  if (sectionKind === "deduction") {
    return -value
  }

  return value
}

function BreakdownValue({
  field,
  sectionKind,
  value,
  lineAmount,
  rawLineAmount,
  displayMinutes,
}: {
  field: PayslipFieldDefinition
  sectionKind: BreakdownSectionKind
  value: unknown
  lineAmount?: number
  rawLineAmount?: number
  displayMinutes?: number | null
}) {
  if (typeof value !== "number") {
    return "—"
  }

  const amount = getDisplayAmount({
    sectionKind,
    value,
    lineAmount,
  })

  // ponytail: raw amount for click-to-reveal — uses unrounded computation
  const rawAmount = rawLineAmount !== undefined
    ? getDisplayAmount({ sectionKind, value, lineAmount: rawLineAmount })
    : amount

  if (
    displayMinutes !== undefined ||
    field.inputKind === "hours" ||
    field.inputKind === "days"
  ) {
    return (
      <span className="flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5 text-right">
        <span>
          {displayMinutes !== undefined
            ? formatAttendanceDuration(displayMinutes ?? 0)
            : formatQuantity(field, value)}
        </span>
        <span className="text-muted-foreground">/</span>
        <ClickableAmount
          value={amount}
          rawValue={rawAmount}
          signed
          className={cn("font-semibold", getAmountClassName(amount))}
        />
      </span>
    )
  }

  return (
    <ClickableAmount
      value={amount}
      rawValue={rawAmount}
      signed
      className={cn("font-semibold", getAmountClassName(amount))}
    />
  )
}

function BreakdownSection({
  title,
  fields,
  inputs,
  lineAmounts,
  rawLineAmounts,
  attendance,
  sectionKind,
  variant,
}: {
  title: string
  fields: PayslipFieldDefinition[]
  inputs: PayslipPayrollInputs
  lineAmounts?: Record<string, number>
  rawLineAmounts?: Record<string, number>
  attendance?: PayslipAttendanceDisplay
  sectionKind: BreakdownSectionKind
  variant: "default" | "dashboard"
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <dl className="grid gap-2 sm:grid-cols-2">
        {fields.map((field) => {
          const value = inputs[field.key as keyof PayslipPayrollInputs]
          const displayMinutes =
            field.key === "tardiness"
              ? (attendance?.tardinessMinutes ?? 0)
              : field.key === "undertime"
                ? (attendance?.undertimeMinutes ?? 0)
                : undefined
          return (
            <div
              key={field.key}
              className={cn(
                "flex items-baseline justify-between gap-3 rounded-xl px-3 py-2.5 text-sm",
                variant === "dashboard"
                  ? "dashboard-chart-card"
                  : "border bg-muted/30"
              )}
            >
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="shrink-0 font-medium tabular-nums">
                <BreakdownValue
                  field={field}
                  sectionKind={sectionKind}
                  value={value}
                  lineAmount={lineAmounts?.[field.key]}
                  rawLineAmount={rawLineAmounts?.[field.key]}
                  displayMinutes={displayMinutes}
                />
              </dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}

export function PayslipBreakdown({
  inputs,
  divisor,
  attendance,
  variant = "default",
}: PayslipBreakdownProps) {
  const calculation = calculatePayslipTotals(inputs, divisor)

  return (
    <div className="flex flex-col gap-5">
      <BreakdownSection
        title="Pay Details"
        fields={PAY_DETAILS_FIELDS}
        inputs={inputs}
        lineAmounts={calculation.lineAmounts}
        rawLineAmounts={calculation.rawLineAmounts}
        attendance={attendance}
        sectionKind="pay"
        variant={variant}
      />
      <BreakdownSection
        title="Deductions"
        fields={DEDUCTION_FIELDS}
        inputs={inputs}
        sectionKind="deduction"
        variant={variant}
      />
      <BreakdownSection
        title="Non-Taxable Earnings"
        fields={NON_TAXABLE_FIELDS}
        inputs={inputs}
        sectionKind="nonTaxable"
        variant={variant}
      />
    </div>
  )
}
