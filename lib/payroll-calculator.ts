import {
  ALL_PAYSLIP_FIELD_KEYS,
  DEDUCTION_FIELDS,
  NON_TAXABLE_ADJUSTMENT_PAIRS,
  NON_TAXABLE_FIELDS,
  PAY_DETAILS_FIELDS,
} from "@/lib/payslip-fields"
import type { EmployeeDivisor } from "@/lib/employee-options"
import { getPayslipFieldMaxLengthByKey } from "@/lib/input-limits"
import {
  CUTOFF_PERIOD_DAYS,
  HOURS_PER_DAY,
  PAYROLL_RATE_MULTIPLIERS,
  type PayrollRateKey,
} from "@/lib/payroll-rates"
import { parseScheduleTimeValue } from "@/lib/schedule-time"
import type {
  Employee,
  EmployeeScheduleDay,
  Payroll,
  PayslipAttendanceDisplay,
  PayslipPayrollInputs,
  PayslipTotals,
} from "@/lib/types"

export const DERIVED_PAYSLIP_FIELD_KEYS = [
  "basicPay",
  "absencesDays",
  "tardiness",
  "undertime",
  "nd",
  "ndOt",
  "regOt",
  "rdOt",
  "rdOtOver8",
  "rdotNd",
  "legal",
  "legalOver8",
  "special",
  "spclOver8",
  "lglNd",
  "spclNd",
  // ponytail: spclRd/spclRdOver8 not derivable from schedule — no way to
  // distinguish "special holiday on rest day" vs normal special holiday from
  // shift type alone. These are manual-entry or CSV-import only.
  "spclRd",
  "spclRdOver8",
  "clothAdj",
  "emplachAdj",
  "holrepAdj",
  "laundryAdj",
  "medasstAdj",
  "medcashAdj",
  "otmealAdj",
  "riceSubsidyAdj",
  "dmbAdj",
] as const satisfies readonly (keyof PayslipPayrollInputs)[]

// ponytail: fields in DERIVED_PAYSLIP_FIELD_KEYS that cannot actually be
// derived from the schedule and should be preserved across schedule saves.
// They are still "derived" for UI read-only purposes but won't be zeroed.
const PRESERVED_DERIVED_FIELDS = new Set<keyof PayslipPayrollInputs>([
  "spclRd",
  "spclRdOver8",
])

const NIGHT_DIFFERENTIAL_START_MINUTE = 22 * 60
const NIGHT_DIFFERENTIAL_END_MINUTE = 6 * 60

const DERIVED_PAYSLIP_FIELDS = new Set<keyof PayslipPayrollInputs>(
  DERIVED_PAYSLIP_FIELD_KEYS
)
const NON_TAXABLE_ADJUSTMENT_FIELD_KEYS = new Set<string>(
  NON_TAXABLE_ADJUSTMENT_PAIRS.map(({ adjKey }) => adjKey)
)

type AttendanceAdjustmentBasis = {
  absencesDays: number
  tardyMinutes: number
  undertimeMinutes: number
}

export function createEmptyPayslipInputs(): PayslipPayrollInputs {
  return ALL_PAYSLIP_FIELD_KEYS.reduce((acc, key) => {
    acc[key as keyof PayslipPayrollInputs] = 0
    return acc
  }, {} as PayslipPayrollInputs)
}

export function createPayslipInputsWithBasicPay(
  basicPay: number
): PayslipPayrollInputs {
  return {
    ...createEmptyPayslipInputs(),
    basicPay,
  }
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function getDailyRate(
  basicPay: number,
  divisor: EmployeeDivisor | number = CUTOFF_PERIOD_DAYS * 24
): number {
  return roundMoney((basicPay * 24) / divisor)
}

function getHourlyRate(
  basicPay: number,
  divisor: EmployeeDivisor | number = CUTOFF_PERIOD_DAYS * 24
): number {
  return getDailyRate(basicPay, divisor) / HOURS_PER_DAY
}

function getPerMinuteRate(
  basicPay: number,
  divisor: EmployeeDivisor | number
): number {
  return getHourlyRate(basicPay, divisor) / 60
}

function reverseMinutesFromPesoDeduction(
  amount: number,
  basicPay: number,
  divisor: EmployeeDivisor | number
): number {
  const perMinuteRate = getPerMinuteRate(basicPay, divisor)
  if (amount <= 0 || perMinuteRate <= 0) {
    return 0
  }

  return amount / perMinuteRate
}

function computeNonTaxableAdjustment(
  allowanceBase: number,
  divisor: EmployeeDivisor | number,
  basis: AttendanceAdjustmentBasis
): number {
  if (allowanceBase <= 0) {
    return 0
  }

  const dailyRate = getDailyRate(allowanceBase, divisor)
  const minuteRate = dailyRate / HOURS_PER_DAY / 60
  const rawAdjustment = -(
    basis.absencesDays * dailyRate +
    (basis.tardyMinutes + basis.undertimeMinutes) * minuteRate
  )
  if (rawAdjustment === 0) {
    return 0
  }

  return roundMoney(Math.max(rawAdjustment, -allowanceBase))
}

export function applyNonTaxableAttendanceAdjustments(
  inputs: PayslipPayrollInputs,
  divisor: EmployeeDivisor | number,
  basis?: AttendanceAdjustmentBasis
): PayslipPayrollInputs {
  const next = { ...inputs }
  const adjustmentBasis =
    basis ??
    {
      absencesDays: inputs.absencesDays ?? 0,
      tardyMinutes: reverseMinutesFromPesoDeduction(
        inputs.tardiness ?? 0,
        inputs.basicPay ?? 0,
        divisor
      ),
      undertimeMinutes: reverseMinutesFromPesoDeduction(
        inputs.undertime ?? 0,
        inputs.basicPay ?? 0,
        divisor
      ),
    }

  for (const { baseKey, adjKey } of NON_TAXABLE_ADJUSTMENT_PAIRS) {
    next[adjKey] = computeNonTaxableAdjustment(
      next[baseKey] ?? 0,
      divisor,
      adjustmentBasis
    )
  }

  next.dmbAdj = roundMoney(
    NON_TAXABLE_ADJUSTMENT_PAIRS.reduce(
      (sum, { adjKey }) => sum + (next[adjKey] ?? 0),
      0
    )
  )

  return next
}

function computeHourLineAmount(
  hours: number,
  basicPay: number,
  rateKey: PayrollRateKey,
  divisor?: EmployeeDivisor | number
): number {
  if (hours <= 0 || basicPay <= 0) {
    return 0
  }
  const hourlyRate = getHourlyRate(basicPay, divisor)
  return roundMoney(hours * hourlyRate * PAYROLL_RATE_MULTIPLIERS[rateKey])
}

// ponytail: unrounded version for audit display
function computeHourLineAmountRaw(
  hours: number,
  basicPay: number,
  rateKey: PayrollRateKey,
  divisor?: EmployeeDivisor | number
): number {
  if (hours <= 0 || basicPay <= 0) {
    return 0
  }
  const hourlyRate = getHourlyRate(basicPay, divisor)
  return hours * hourlyRate * PAYROLL_RATE_MULTIPLIERS[rateKey]
}

function sumFields(
  inputs: PayslipPayrollInputs,
  fields: { key: string }[]
): number {
  return fields.reduce((sum, field) => {
    const value = inputs[field.key as keyof PayslipPayrollInputs]
    return sum + (typeof value === "number" ? value : 0)
  }, 0)
}

export type PayslipCalculationResult = PayslipTotals & {
  lineAmounts: Record<string, number>
  // ponytail: unrounded line amounts for audit display — same keys as lineAmounts
  // but without the roundMoney() call on hours-based computations.
  rawLineAmounts: Record<string, number>
}

export function calculatePayslipTotals(
  inputs: PayslipPayrollInputs,
  divisor?: EmployeeDivisor | number
): PayslipCalculationResult {
  const lineAmounts: Record<string, number> = {}
  const basicPay = inputs.basicPay ?? 0

  lineAmounts.basicPay = roundMoney(basicPay)
  lineAmounts.absencesDays = roundMoney(
    -(inputs.absencesDays ?? 0) * getDailyRate(basicPay, divisor)
  )
  lineAmounts.tardiness = roundMoney(-(inputs.tardiness ?? 0))
  lineAmounts.undertime = roundMoney(-(inputs.undertime ?? 0))

  for (const field of PAY_DETAILS_FIELDS) {
    if (field.inputKind !== "hours" || !field.rateKey) {
      continue
    }
    const hours = inputs[field.key as keyof PayslipPayrollInputs] ?? 0
    lineAmounts[field.key] = computeHourLineAmount(
      typeof hours === "number" ? hours : 0,
      basicPay,
      field.rateKey,
      divisor
    )
  }

  const manualPesoPayDetailKeys = PAY_DETAILS_FIELDS.filter(
    (field) =>
      field.inputKind === "peso" &&
      !["basicPay", "tardiness", "undertime"].includes(field.key)
  ).map((field) => field.key)

  for (const key of manualPesoPayDetailKeys) {
    lineAmounts[key] = roundMoney(
      inputs[key as keyof PayslipPayrollInputs] ?? 0
    )
  }

  const taxableEarnings = roundMoney(
    Object.entries(lineAmounts)
      .filter(([key]) => PAY_DETAILS_FIELDS.some((field) => field.key === key))
      .reduce((sum, [, amount]) => sum + amount, 0)
  )

  const totalDeductions = roundMoney(sumFields(inputs, DEDUCTION_FIELDS))
  const nonTaxableEarnings = roundMoney(sumFields(inputs, NON_TAXABLE_FIELDS))
  const grossPay = roundMoney(taxableEarnings + nonTaxableEarnings)
  const netPay = roundMoney(grossPay - totalDeductions)

  // ponytail: build rawLineAmounts with unrounded hour-based computations
  const rawLineAmounts: Record<string, number> = { ...lineAmounts }
  for (const field of PAY_DETAILS_FIELDS) {
    if (field.inputKind !== "hours" || !field.rateKey) {
      continue
    }
    const hours = inputs[field.key as keyof PayslipPayrollInputs] ?? 0
    rawLineAmounts[field.key] = computeHourLineAmountRaw(
      typeof hours === "number" ? hours : 0,
      basicPay,
      field.rateKey,
      divisor
    )
  }

  return {
    lineAmounts,
    rawLineAmounts,
    taxableEarnings,
    totalDeductions,
    nonTaxableEarnings,
    grossPay,
    netPay,
  }
}

function parseMinutes(value: string): number | null {
  const normalized = parseScheduleTimeValue(value)
  if (!normalized) {
    return null
  }
  const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (!match) {
    return null
  }
  return Number(match[1]) * 60 + Number(match[2])
}

function minutesBetween(start: string, end: string): number | null {
  const startMinutes = parseMinutes(start)
  const endMinutes = parseMinutes(end)
  if (startMinutes === null || endMinutes === null) {
    return null
  }

  return endMinutes >= startMinutes
    ? endMinutes - startMinutes
    : endMinutes + 24 * 60 - startMinutes
}

function minutesAfter(start: string, end: string): number {
  const minutes = minutesBetween(start, end)
  return minutes === null ? 0 : minutes
}

function floorToHalfHour(minutes: number): number {
  if (minutes <= 0) {
    return 0
  }
  return Math.floor(minutes / 30) * 0.5
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100
}

function hasLogPair(day: EmployeeScheduleDay): boolean {
  return Boolean(day.logIn && day.logOut)
}

function hasShiftPair(day: EmployeeScheduleDay): boolean {
  return Boolean(day.shiftIn && day.shiftOut)
}

type ShiftLogTimeline = {
  shiftIn: number
  shiftOut: number
  logIn: number
  logOut: number
}

function normalizeEndMinute(start: number, end: number): number {
  return end <= start ? end + 24 * 60 : end
}

function findNearestMinute(value: number, target: number): number {
  const candidates = [value - 24 * 60, value, value + 24 * 60]
  return candidates.reduce((nearest, candidate) => {
    return Math.abs(candidate - target) < Math.abs(nearest - target)
      ? candidate
      : nearest
  })
}

function getShiftLogTimeline(
  day: EmployeeScheduleDay
): ShiftLogTimeline | null {
  if (!hasLogPair(day) || !hasShiftPair(day)) {
    return null
  }

  const shiftIn = parseMinutes(day.shiftIn)
  const shiftOut = parseMinutes(day.shiftOut)
  const logIn = parseMinutes(day.logIn)
  const logOut = parseMinutes(day.logOut)
  if (
    shiftIn === null ||
    shiftOut === null ||
    logIn === null ||
    logOut === null
  ) {
    return null
  }

  const normalizedShiftOut = normalizeEndMinute(shiftIn, shiftOut)
  const normalizedLogIn = findNearestMinute(logIn, shiftIn)
  let normalizedLogOut = findNearestMinute(logOut, normalizedShiftOut)
  if (normalizedLogOut <= normalizedLogIn) {
    normalizedLogOut += 24 * 60
  }

  return {
    shiftIn,
    shiftOut: normalizedShiftOut,
    logIn: normalizedLogIn,
    logOut: normalizedLogOut,
  }
}

function countOvertimeHours(day: EmployeeScheduleDay): number {
  const timeline = getShiftLogTimeline(day)
  if (!timeline) {
    return 0
  }

  const overtimeMinutes =
    timeline.logOut > timeline.shiftOut
      ? timeline.logOut - timeline.shiftOut
      : 0
  return floorToHalfHour(overtimeMinutes)
}

// ponytail: night differential during overtime — minutes after shiftOut that
// also fall within the 22:00–06:00 night window.
function countNightDifferentialOvertimeHours(
  day: EmployeeScheduleDay
): number {
  const timeline = getShiftLogTimeline(day)
  if (!timeline) {
    return 0
  }

  const otStart = timeline.shiftOut
  const otEnd = timeline.logOut
  if (otEnd <= otStart) {
    return 0
  }

  const nightWindows: [number, number][] = [
    [-24 * 60, NIGHT_DIFFERENTIAL_END_MINUTE - 24 * 60],
    [NIGHT_DIFFERENTIAL_START_MINUTE - 24 * 60, 0],
    [0, NIGHT_DIFFERENTIAL_END_MINUTE],
    [NIGHT_DIFFERENTIAL_START_MINUTE, 24 * 60 + NIGHT_DIFFERENTIAL_END_MINUTE],
  ]

  const nightMinutes = nightWindows.reduce((sum, [windowStart, windowEnd]) => {
    const overlapStart = Math.max(otStart, windowStart)
    const overlapEnd = Math.min(otEnd, windowEnd)
    return sum + Math.max(0, overlapEnd - overlapStart)
  }, 0)

  return roundHours(nightMinutes / 60)
}

function countWorkedHolidayHours(day: EmployeeScheduleDay): number {
  if (!hasLogPair(day)) {
    return 0
  }

  const workedMinutes = minutesAfter(day.logIn, day.logOut)
  return roundHours(Math.min(workedMinutes / 60, HOURS_PER_DAY))
}

function countHolidayOver8Hours(day: EmployeeScheduleDay): number {
  if (!hasLogPair(day)) {
    return 0
  }

  if (hasShiftPair(day)) {
    return countOvertimeHours(day)
  }

  const workedMinutes = minutesAfter(day.logIn, day.logOut)
  return floorToHalfHour(Math.max(0, workedMinutes - HOURS_PER_DAY * 60))
}

function countNightDifferentialHours(day: EmployeeScheduleDay): number {
  const start = parseMinutes(day.logIn)
  const end = parseMinutes(day.logOut)
  if (start === null || end === null) {
    return 0
  }

  const timeline = getShiftLogTimeline(day)
  const adjustedStart = timeline?.logIn ?? start
  const adjustedEnd = timeline?.logOut ?? normalizeEndMinute(start, end)
  const nightWindows: [number, number][] = [
    [-24 * 60, NIGHT_DIFFERENTIAL_END_MINUTE - 24 * 60],
    [NIGHT_DIFFERENTIAL_START_MINUTE - 24 * 60, 0],
    [0, NIGHT_DIFFERENTIAL_END_MINUTE],
    [NIGHT_DIFFERENTIAL_START_MINUTE, 24 * 60 + NIGHT_DIFFERENTIAL_END_MINUTE],
  ]

  const nightMinutes = nightWindows.reduce((sum, [windowStart, windowEnd]) => {
    const overlapStart = Math.max(adjustedStart, windowStart)
    const overlapEnd = Math.min(adjustedEnd, windowEnd)
    return sum + Math.max(0, overlapEnd - overlapStart)
  }, 0)

  return roundHours(nightMinutes / 60)
}

function isWorkRequired(day: EmployeeScheduleDay): boolean {
  return day.shiftType === "scheduledShift" || day.shiftType === "legalHoliday"
}

export function calculatePayslipAttendanceDisplay(
  scheduleDays: EmployeeScheduleDay[]
): PayslipAttendanceDisplay {
  let tardyMinutes = 0
  let undertimeMinutes = 0

  for (const day of scheduleDays) {
    if (!isWorkRequired(day) || !hasShiftPair(day) || !hasLogPair(day)) {
      continue
    }

    const timeline = getShiftLogTimeline(day)
    if (!timeline) {
      continue
    }

    if (timeline.logIn > timeline.shiftIn) {
      tardyMinutes += timeline.logIn - timeline.shiftIn
    }

    if (timeline.logOut < timeline.shiftOut) {
      undertimeMinutes += timeline.shiftOut - timeline.logOut
    }
  }

  return {
    tardinessMinutes: tardyMinutes,
    undertimeMinutes,
  }
}

export function formatAttendanceDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) {
    return "0 hrs"
  }

  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60

  if (hours === 0) {
    return `0 hrs and ${mins} ${mins === 1 ? "min" : "mins"}`
  }

  if (mins === 0) {
    return `${hours} ${hours === 1 ? "hr" : "hrs"}`
  }

  return `${hours} ${hours === 1 ? "hr" : "hrs"} and ${mins} ${mins === 1 ? "min" : "mins"}`
}

export function derivePayslipInputsFromSchedule({
  employee,
  scheduleDays,
  existingInputs,
}: {
  employee: Employee
  payroll: Payroll
  scheduleDays: EmployeeScheduleDay[]
  existingInputs?: PayslipPayrollInputs
}): PayslipPayrollInputs {
  const inputs = {
    ...createEmptyPayslipInputs(),
    ...(existingInputs ?? {}),
  }
  const perMinuteRate = getPerMinuteRate(employee.basicPay, employee.divisor)
  const fallbackAttendanceBasis: AttendanceAdjustmentBasis = {
    absencesDays: inputs.absencesDays ?? 0,
    tardyMinutes: reverseMinutesFromPesoDeduction(
      inputs.tardiness ?? 0,
      employee.basicPay,
      employee.divisor
    ),
    undertimeMinutes: reverseMinutesFromPesoDeduction(
      inputs.undertime ?? 0,
      employee.basicPay,
      employee.divisor
    ),
  }
  const scheduleAttendanceBasis: AttendanceAdjustmentBasis = {
    absencesDays: 0,
    tardyMinutes: 0,
    undertimeMinutes: 0,
  }
  const hasScheduleAttendanceSource = scheduleDays.some(isWorkRequired)

  for (const key of DERIVED_PAYSLIP_FIELDS) {
    if (!PRESERVED_DERIVED_FIELDS.has(key)) {
      inputs[key] = 0
    }
  }

  inputs.basicPay = roundMoney(employee.basicPay)

  for (const day of scheduleDays) {
    const hasLogs = hasLogPair(day)

    if (isWorkRequired(day) && !hasLogs) {
      inputs.absencesDays += 1
      scheduleAttendanceBasis.absencesDays += 1
      continue
    }

    if (!hasLogs) {
      continue
    }

    if (isWorkRequired(day) && hasShiftPair(day)) {
      const timeline = getShiftLogTimeline(day)

      if (timeline && timeline.logIn > timeline.shiftIn) {
        scheduleAttendanceBasis.tardyMinutes +=
          timeline.logIn - timeline.shiftIn
      }

      if (timeline && timeline.logOut < timeline.shiftOut) {
        scheduleAttendanceBasis.undertimeMinutes +=
          timeline.shiftOut - timeline.logOut
      }
    }

    if (day.shiftType === "scheduledShift") {
      inputs.nd += countNightDifferentialHours(day)
      inputs.regOt += countOvertimeHours(day)
      inputs.ndOt += countNightDifferentialOvertimeHours(day)
    } else if (day.shiftType === "restDay") {
      // ponytail: rest day with logs — all worked hours are RD OT
      inputs.rdOt += countWorkedHolidayHours(day)
      inputs.rdOtOver8 += countHolidayOver8Hours(day)
      inputs.rdotNd += countNightDifferentialHours(day)
    } else if (day.shiftType === "legalHoliday") {
      inputs.legal += countWorkedHolidayHours(day)
      inputs.legalOver8 += countHolidayOver8Hours(day)
      inputs.lglNd += countNightDifferentialHours(day)
    } else if (day.shiftType === "specialHoliday") {
      inputs.special += countWorkedHolidayHours(day)
      inputs.spclOver8 += countHolidayOver8Hours(day)
      inputs.spclNd += countNightDifferentialHours(day)
    }
  }

  if (!hasScheduleAttendanceSource) {
    inputs.absencesDays = fallbackAttendanceBasis.absencesDays
    inputs.tardiness = roundMoney(fallbackAttendanceBasis.tardyMinutes * perMinuteRate)
    inputs.undertime = roundMoney(
      fallbackAttendanceBasis.undertimeMinutes * perMinuteRate
    )
  } else {
    inputs.tardiness = roundMoney(
      scheduleAttendanceBasis.tardyMinutes * perMinuteRate
    )
    inputs.undertime = roundMoney(
      scheduleAttendanceBasis.undertimeMinutes * perMinuteRate
    )
  }

  inputs.absencesDays = roundHours(inputs.absencesDays)
  inputs.tardiness = roundMoney(inputs.tardiness)
  inputs.undertime = roundMoney(inputs.undertime)
  inputs.nd = roundHours(inputs.nd)
  inputs.ndOt = roundHours(inputs.ndOt)
  inputs.regOt = roundHours(inputs.regOt)
  inputs.rdOt = roundHours(inputs.rdOt)
  inputs.rdOtOver8 = roundHours(inputs.rdOtOver8)
  inputs.rdotNd = roundHours(inputs.rdotNd)
  inputs.legal = roundHours(inputs.legal)
  inputs.legalOver8 = roundHours(inputs.legalOver8)
  inputs.lglNd = roundHours(inputs.lglNd)
  inputs.special = roundHours(inputs.special)
  inputs.spclOver8 = roundHours(inputs.spclOver8)
  inputs.spclNd = roundHours(inputs.spclNd)

  return applyNonTaxableAttendanceAdjustments(
    inputs,
    employee.divisor,
    hasScheduleAttendanceSource
      ? scheduleAttendanceBasis
      : fallbackAttendanceBasis
  )
}

export function parseDecimalInput(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return 0
  }
  // ponytail: strip thousands-separator commas and currency symbols so Excel
  // round-trip values like "₱1,234.50" or "1,234.50" parse correctly.
  // Also handle accounting-style negatives "(500.00)" → "-500.00".
  // Ceiling: assumes period decimal separator.
  let cleaned = trimmed.replace(/[₱$,\s]/g, "")
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    cleaned = "-" + cleaned.slice(1, -1)
  }
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) {
    return NaN
  }
  return parsed
}

export function parsePayslipInputsFromFormData(
  formData: FormData
): PayslipPayrollInputs | { error: string } {
  const inputs = createEmptyPayslipInputs()

  for (const key of ALL_PAYSLIP_FIELD_KEYS) {
    if (NON_TAXABLE_ADJUSTMENT_FIELD_KEYS.has(key) || key === "dmbAdj") {
      continue
    }

    const rawValue = String(formData.get(key) ?? "").trim()
    const maxLength = getPayslipFieldMaxLengthByKey(key)
    if (maxLength !== undefined && rawValue.length > maxLength) {
      return { error: `${key} must be at most ${maxLength} characters.` }
    }

    const parsed = parseDecimalInput(rawValue)
    if (Number.isNaN(parsed)) {
      return { error: `Invalid number for ${key}.` }
    }
    if (parsed < 0) {
      return { error: `${key} cannot be negative.` }
    }
    inputs[key as keyof PayslipPayrollInputs] = parsed
  }

  return inputs
}
