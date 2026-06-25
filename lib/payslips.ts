import "server-only"

import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm"

import { db, withDbRetry, type DatabaseClient } from "@/db"
import {
  employeeSchedules,
  employees as employeesTable,
  payrolls as payrollsTable,
  payslipInputs,
  payslips,
} from "@/db/schema"
import { normalizeEmployeeId } from "@/lib/auth-helpers"
import { getScheduleByPayrollAndEmployee } from "@/lib/employee-schedules"
import {
  buildEmployeeYtdSummary,
  type EmployeeYtdPayslipSource,
} from "@/lib/employee-ytd"
import { findEmployeeByEmployeeId, getEmployees } from "@/lib/employees"
import { parseIsoDate } from "@/lib/payroll-dates"
import {
  buildPaginatedResult,
  normalizePagination,
  type PaginatedResult,
  type PaginationInput,
} from "@/lib/pagination"
import {
  calculatePayslipAttendanceDisplay,
  calculatePayslipTotals,
  createEmptyPayslipInputs,
  createPayslipInputsWithBasicPay,
  derivePayslipInputsFromSchedule,
} from "@/lib/payroll-calculator"
import { mergeScheduleDays } from "@/lib/schedule-days"
import type {
  Employee,
  EmployeePayslip,
  EmployeePayslipListItem,
  EmployeeScheduleDay,
  EmployeeYtdOverview,
  Payroll,
  Payslip,
  PayslipListItem,
  PayslipPayrollInputs,
  PayslipPdfData,
  PayslipStatus,
  PayslipTotals,
} from "@/lib/types"
import type { SortDirection } from "@/lib/table-sort"

const VISIBLE_EMPLOYEE_PAYSLIP_STATUSES: PayslipStatus[] = ["approved", "sent"]

function employeeScheduleJoinCondition() {
  return and(
    eq(employeeSchedules.payrollId, payslips.payrollId),
    eq(employeeSchedules.employeeId, payslips.employeeId)
  )
}

const PAYSLIP_STATUSES: PayslipStatus[] = [
  "draft",
  "pending",
  "adminApproved",
  "approved",
  "returned",
  "sent",
]

function buildPayslipTotals(
  inputs: PayslipPayrollInputs,
  divisor?: Employee["divisor"]
) {
  const totals = calculatePayslipTotals(inputs, divisor)
  return {
    taxableEarnings: totals.taxableEarnings,
    totalDeductions: totals.totalDeductions,
    nonTaxableEarnings: totals.nonTaxableEarnings,
    grossPay: totals.grossPay,
    netPay: totals.netPay,
  }
}

type PayslipPayrollRow = typeof payrollsTable.$inferSelect

function resolveAttendanceScheduleDays(
  payroll: PayslipPayrollRow | null | undefined,
  scheduleDays?: EmployeeScheduleDay[]
): EmployeeScheduleDay[] {
  const days = scheduleDays ?? []
  return payroll ? mergeScheduleDays(payroll, days) : days
}

function mapPayslipRow(row: {
  payslip: typeof payslips.$inferSelect
  payslipInput: typeof payslipInputs.$inferSelect | null
  employee: typeof employeesTable.$inferSelect | null
  schedule?: typeof employeeSchedules.$inferSelect | null
  payroll?: PayslipPayrollRow | null
}): Payslip {
  const inputs = {
    ...createEmptyPayslipInputs(),
    ...(row.payslipInput?.inputs ?? {}),
  }
  const totals = buildPayslipTotals(inputs, row.employee?.divisor)
  const scheduleDays = resolveAttendanceScheduleDays(
    row.payroll,
    row.schedule?.days
  )

  return {
    id: row.payslip.id,
    payrollId: row.payslip.payrollId,
    employeeId: row.payslip.employeeId,
    employeeName: row.employee?.name ?? row.payslip.employeeId,
    status: row.payslip.status,
    inputs,
    totals,
    attendance: calculatePayslipAttendanceDisplay(scheduleDays),
  }
}

function mapPayslipListItem(row: {
  payslip: typeof payslips.$inferSelect
  employee: typeof employeesTable.$inferSelect | null
}): PayslipListItem {
  return {
    id: row.payslip.id,
    payrollId: row.payslip.payrollId,
    employeeId: row.payslip.employeeId,
    employeeName: row.employee?.name ?? row.payslip.employeeId,
    status: row.payslip.status,
  }
}

async function resolveDerivedPayslipInputs({
  employee,
  payroll,
  inputs,
  client,
}: {
  employee: Employee
  payroll: Payroll
  inputs: PayslipPayrollInputs
  client: DatabaseClient
}) {
  const schedule = await getScheduleByPayrollAndEmployee(
    payroll.id,
    employee.employeeId,
    client
  )

  return derivePayslipInputsFromSchedule({
    employee,
    payroll,
    scheduleDays: schedule?.days ?? [],
    existingInputs: inputs,
  })
}

function mapPayslipPdfRow(row: {
  payslip: typeof payslips.$inferSelect
  payslipInput: typeof payslipInputs.$inferSelect | null
  employee: typeof employeesTable.$inferSelect
  schedule?: typeof employeeSchedules.$inferSelect | null
  payroll: PayslipPayrollRow
}): PayslipPdfData {
  return {
    ...mapPayslipRow(row),
    employeeDivisor: row.employee.divisor,
    tin: row.employee.tin,
    sssNo: row.employee.sssNo,
    phicNo: row.employee.phicNo,
    hdmfNo: row.employee.hdmfNo,
    payrollPeriodLabel: row.payroll.payrollPeriodLabel,
    payrollPeriodStart: row.payroll.payrollPeriodStart,
    payrollPeriodEnd: row.payroll.payrollPeriodEnd,
    dtrCutOffStart: row.payroll.dtrCutOffStart,
    dtrCutOffEnd: row.payroll.dtrCutOffEnd,
    payoutDate: row.payroll.payoutDate,
  }
}

function mapEmployeePayslipRow(row: {
  payslip: typeof payslips.$inferSelect
  payslipInput: typeof payslipInputs.$inferSelect | null
  employee: typeof employeesTable.$inferSelect | null
  schedule?: typeof employeeSchedules.$inferSelect | null
  payroll: PayslipPayrollRow
}): EmployeePayslip {
  return {
    ...mapPayslipRow(row),
    payrollPeriodLabel: row.payroll.payrollPeriodLabel,
    payrollPeriodStart: row.payroll.payrollPeriodStart,
    payrollPeriodEnd: row.payroll.payrollPeriodEnd,
    dtrCutOffStart: row.payroll.dtrCutOffStart,
    dtrCutOffEnd: row.payroll.dtrCutOffEnd,
    payoutDate: row.payroll.payoutDate,
  }
}

export type PayslipListSort = "employeeName" | "employeeId" | "status"

export type PayslipListQuery = PaginationInput & {
  payrollId?: string
  employeeId?: string
  statuses?: PayslipStatus[]
  sort?: PayslipListSort
  direction?: SortDirection
}

export type PayrollPayslipMetrics = {
  statusCounts: Record<PayslipStatus, number>
  totals: PayslipTotals
}

function getPayslipSortColumn(sort: PayslipListSort) {
  if (sort === "employeeName") {
    return employeesTable.name
  }
  if (sort === "employeeId") {
    return payslips.employeeId
  }
  return payslips.status
}

function buildPayslipWhere(query: PayslipListQuery) {
  const conditions = []

  if (query.payrollId) {
    conditions.push(eq(payslips.payrollId, query.payrollId))
  }
  if (query.employeeId) {
    conditions.push(
      eq(payslips.employeeId, normalizeEmployeeId(query.employeeId))
    )
  }
  if (query.statuses && query.statuses.length > 0) {
    conditions.push(inArray(payslips.status, query.statuses))
  }

  return conditions.length > 0 ? and(...conditions) : undefined
}

export async function getPaginatedPayslipListItems(
  query: PayslipListQuery = {},
  client: DatabaseClient = db
): Promise<PaginatedResult<PayslipListItem>> {
  const pagination = normalizePagination(query)
  const where = buildPayslipWhere(query)
  const sort = query.sort ?? "employeeName"
  const direction = query.direction === "desc" ? "desc" : "asc"
  const orderBy =
    direction === "desc"
      ? desc(getPayslipSortColumn(sort))
      : asc(getPayslipSortColumn(sort))

  const [totalRow] = await client
    .select({ count: count() })
    .from(payslips)
    .where(where)
  const rows = await client
    .select({
      payslip: payslips,
      employee: employeesTable,
    })
    .from(payslips)
    .leftJoin(
      employeesTable,
      eq(employeesTable.employeeId, payslips.employeeId)
    )
    .where(where)
    .orderBy(orderBy, asc(payslips.employeeId))
    .limit(pagination.pageSize)
    .offset(pagination.offset)

  return buildPaginatedResult(
    rows.map(mapPayslipListItem),
    totalRow?.count ?? 0,
    pagination
  )
}

export async function getPaginatedPayslips(
  query: PayslipListQuery = {},
  client: DatabaseClient = db
): Promise<PaginatedResult<Payslip>> {
  const pagination = normalizePagination(query)
  const where = buildPayslipWhere(query)
  const sort = query.sort ?? "employeeName"
  const direction = query.direction === "desc" ? "desc" : "asc"
  const orderBy =
    direction === "desc"
      ? desc(getPayslipSortColumn(sort))
      : asc(getPayslipSortColumn(sort))

  const [totalRow] = await client
    .select({ count: count() })
    .from(payslips)
    .where(where)
  const rows = await client
    .select({
      payslip: payslips,
      payslipInput: payslipInputs,
      employee: employeesTable,
      schedule: employeeSchedules,
      payroll: payrollsTable,
    })
    .from(payslips)
    .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .leftJoin(
      employeesTable,
      eq(employeesTable.employeeId, payslips.employeeId)
    )
    .leftJoin(employeeSchedules, employeeScheduleJoinCondition())
    .leftJoin(payrollsTable, eq(payrollsTable.id, payslips.payrollId))
    .where(where)
    .orderBy(orderBy, asc(payslips.employeeId))
    .limit(pagination.pageSize)
    .offset(pagination.offset)

  return buildPaginatedResult(
    rows.map(mapPayslipRow),
    totalRow?.count ?? 0,
    pagination
  )
}

export async function getPayslipCountByPayrollId(
  payrollId: string,
  client: DatabaseClient = db
): Promise<number> {
  const [row] = await client
    .select({ count: count() })
    .from(payslips)
    .where(eq(payslips.payrollId, payrollId))
  return row?.count ?? 0
}

export async function getPayrollPayslipMetrics(
  payrollId: string,
  client: DatabaseClient = db
): Promise<PayrollPayslipMetrics> {
  return withDbRetry(async () => {
    const statusRows = await client
      .select({
        status: payslips.status,
        count: count(),
      })
      .from(payslips)
      .where(eq(payslips.payrollId, payrollId))
      .groupBy(payslips.status)
    const [totalsRow] = await client
      .select({
        grossPay:
          sql<number>`coalesce(sum((${payslipInputs.totals}->>'grossPay')::numeric), 0)`.mapWith(
            Number
          ),
        totalDeductions:
          sql<number>`coalesce(sum((${payslipInputs.totals}->>'totalDeductions')::numeric), 0)`.mapWith(
            Number
          ),
        netPay:
          sql<number>`coalesce(sum((${payslipInputs.totals}->>'netPay')::numeric), 0)`.mapWith(
            Number
          ),
        taxableEarnings:
          sql<number>`coalesce(sum((${payslipInputs.totals}->>'taxableEarnings')::numeric), 0)`.mapWith(
            Number
          ),
        nonTaxableEarnings:
          sql<number>`coalesce(sum((${payslipInputs.totals}->>'nonTaxableEarnings')::numeric), 0)`.mapWith(
            Number
          ),
      })
      .from(payslips)
      .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
      .where(eq(payslips.payrollId, payrollId))
    const statusCounts = Object.fromEntries(
      PAYSLIP_STATUSES.map((status) => [status, 0])
    ) as Record<PayslipStatus, number>

    for (const row of statusRows) {
      statusCounts[row.status] = row.count
    }

    return {
      statusCounts,
      totals: {
        grossPay: totalsRow?.grossPay ?? 0,
        totalDeductions: totalsRow?.totalDeductions ?? 0,
        netPay: totalsRow?.netPay ?? 0,
        taxableEarnings: totalsRow?.taxableEarnings ?? 0,
        nonTaxableEarnings: totalsRow?.nonTaxableEarnings ?? 0,
      },
    }
  })
}

export async function getPayrollPayslipMetricsByPayrollIds(
  payrollIds: string[],
  client: DatabaseClient = db
): Promise<Record<string, PayrollPayslipMetrics>> {
  if (payrollIds.length === 0) {
    return {}
  }

  const statusRows = await client
    .select({
      payrollId: payslips.payrollId,
      status: payslips.status,
      count: count(),
    })
    .from(payslips)
    .where(inArray(payslips.payrollId, payrollIds))
    .groupBy(payslips.payrollId, payslips.status)

  const result: Record<string, PayrollPayslipMetrics> = {}
  for (const payrollId of payrollIds) {
    result[payrollId] = {
      statusCounts: Object.fromEntries(
        PAYSLIP_STATUSES.map((status) => [status, 0])
      ) as Record<PayslipStatus, number>,
      totals: {
        taxableEarnings: 0,
        totalDeductions: 0,
        nonTaxableEarnings: 0,
        grossPay: 0,
        netPay: 0,
      },
    }
  }

  for (const row of statusRows) {
    result[row.payrollId].statusCounts[row.status] = row.count
  }

  return result
}

export async function getPayslipById(
  id: string,
  client: DatabaseClient = db
): Promise<Payslip | null> {
  const [row] = await client
    .select({
      payslip: payslips,
      payslipInput: payslipInputs,
      employee: employeesTable,
      schedule: employeeSchedules,
      payroll: payrollsTable,
    })
    .from(payslips)
    .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .leftJoin(
      employeesTable,
      eq(employeesTable.employeeId, payslips.employeeId)
    )
    .leftJoin(employeeSchedules, employeeScheduleJoinCondition())
    .leftJoin(payrollsTable, eq(payrollsTable.id, payslips.payrollId))
    .where(eq(payslips.id, id))
    .limit(1)

  return row ? mapPayslipRow(row) : null
}

export async function getPayslipsByPayrollId(
  payrollId: string,
  client: DatabaseClient = db
): Promise<Payslip[]> {
  const payroll = await client.query.payrolls.findFirst({
    where: eq(payrollsTable.id, payrollId),
  })
  const rows = await client
    .select({
      payslip: payslips,
      payslipInput: payslipInputs,
      employee: employeesTable,
      schedule: employeeSchedules,
    })
    .from(payslips)
    .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .leftJoin(
      employeesTable,
      eq(employeesTable.employeeId, payslips.employeeId)
    )
    .leftJoin(employeeSchedules, employeeScheduleJoinCondition())
    .where(eq(payslips.payrollId, payrollId))

  return rows.map((row) => mapPayslipRow({ ...row, payroll }))
}

export async function getPayslipByPayrollAndEmployee(
  payrollId: string,
  employeeId: string,
  client: DatabaseClient = db
): Promise<Payslip | null> {
  const normalizedId = normalizeEmployeeId(employeeId)
  const [row] = await client
    .select({
      payslip: payslips,
      payslipInput: payslipInputs,
      employee: employeesTable,
      schedule: employeeSchedules,
      payroll: payrollsTable,
    })
    .from(payslips)
    .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .leftJoin(
      employeesTable,
      eq(employeesTable.employeeId, payslips.employeeId)
    )
    .leftJoin(employeeSchedules, employeeScheduleJoinCondition())
    .leftJoin(payrollsTable, eq(payrollsTable.id, payslips.payrollId))
    .where(
      and(
        eq(payslips.payrollId, payrollId),
        eq(payslips.employeeId, normalizedId)
      )
    )
    .limit(1)

  return row ? mapPayslipRow(row) : null
}

export async function getVisibleEmployeePayslipDetailsByEmployeeAndId(
  employeeId: string,
  id: string,
  client: DatabaseClient = db
): Promise<PayslipPdfData | null> {
  const normalizedId = normalizeEmployeeId(employeeId)
  const [row] = await client
    .select({
      payslip: payslips,
      payslipInput: payslipInputs,
      employee: employeesTable,
      schedule: employeeSchedules,
      payroll: payrollsTable,
    })
    .from(payslips)
    .innerJoin(payrollsTable, eq(payrollsTable.id, payslips.payrollId))
    .innerJoin(
      employeesTable,
      eq(employeesTable.employeeId, payslips.employeeId)
    )
    .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .leftJoin(employeeSchedules, employeeScheduleJoinCondition())
    .where(
      and(
        eq(payslips.id, id),
        eq(payslips.employeeId, normalizedId),
        inArray(payslips.status, VISIBLE_EMPLOYEE_PAYSLIP_STATUSES)
      )
    )
    .limit(1)

  return row ? mapPayslipPdfRow(row) : null
}

export async function getVisiblePayslipsByEmployeeId(
  employeeId: string
): Promise<EmployeePayslip[]> {
  const normalizedId = normalizeEmployeeId(employeeId)
  const rows = await db
    .select({
      payslip: payslips,
      payslipInput: payslipInputs,
      employee: employeesTable,
      schedule: employeeSchedules,
      payroll: payrollsTable,
    })
    .from(payslips)
    .innerJoin(payrollsTable, eq(payrollsTable.id, payslips.payrollId))
    .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .leftJoin(
      employeesTable,
      eq(employeesTable.employeeId, payslips.employeeId)
    )
    .leftJoin(employeeSchedules, employeeScheduleJoinCondition())
    .where(
      and(
        eq(payslips.employeeId, normalizedId),
        inArray(payslips.status, VISIBLE_EMPLOYEE_PAYSLIP_STATUSES)
      )
    )

  return rows.map(mapEmployeePayslipRow).sort((a, b) => {
    return b.payrollPeriodEnd.localeCompare(a.payrollPeriodEnd)
  })
}

/**
 * Builds the employee-facing year-to-date money summary for every year that
 * has visible payslips. Only statuses the employee can already see
 * (`approved`, `sent`) are included, mirroring the rest of the employee flow.
 *
 * A summary is produced per year so the UI can switch between years without an
 * extra round-trip. Years are derived from each payslip's payout date.
 */
export async function getEmployeeYtdOverview(
  employeeId: string,
  client: DatabaseClient = db
): Promise<EmployeeYtdOverview> {
  const normalizedId = normalizeEmployeeId(employeeId)
  const employee = await findEmployeeByEmployeeId(normalizedId, client)
  const rows = await client
    .select({
      inputs: payslipInputs.inputs,
      payoutDate: payrollsTable.payoutDate,
    })
    .from(payslips)
    .innerJoin(payrollsTable, eq(payrollsTable.id, payslips.payrollId))
    .leftJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .where(
      and(
        eq(payslips.employeeId, normalizedId),
        inArray(payslips.status, VISIBLE_EMPLOYEE_PAYSLIP_STATUSES)
      )
    )

  const sourcesByYear = new Map<number, EmployeeYtdPayslipSource[]>()
  for (const row of rows) {
    const year = parseIsoDate(row.payoutDate).getFullYear()
    const inputs = {
      ...createEmptyPayslipInputs(),
      ...(row.inputs ?? {}),
    }
    const list = sourcesByYear.get(year) ?? []
    list.push({ inputs })
    sourcesByYear.set(year, list)
  }

  const availableYears = [...sourcesByYear.keys()].sort((a, b) => b - a)
  const summaries = availableYears.map((year) =>
    buildEmployeeYtdSummary(year, sourcesByYear.get(year) ?? [], employee?.divisor)
  )

  return { availableYears, summaries }
}

export async function getVisibleEmployeePayslipListItems(
  employeeId: string,
  client: DatabaseClient = db
): Promise<EmployeePayslipListItem[]> {
  return withDbRetry(async () => {
    const normalizedId = normalizeEmployeeId(employeeId)
    const rows = await client
      .select({
        payslipId: payslips.id,
        status: payslips.status,
        payrollPeriodLabel: payrollsTable.payrollPeriodLabel,
        payrollPeriodStart: payrollsTable.payrollPeriodStart,
        payrollPeriodEnd: payrollsTable.payrollPeriodEnd,
        dtrCutOffStart: payrollsTable.dtrCutOffStart,
        dtrCutOffEnd: payrollsTable.dtrCutOffEnd,
        payoutDate: payrollsTable.payoutDate,
      })
      .from(payslips)
      .innerJoin(payrollsTable, eq(payrollsTable.id, payslips.payrollId))
      .where(
        and(
          eq(payslips.employeeId, normalizedId),
          inArray(payslips.status, VISIBLE_EMPLOYEE_PAYSLIP_STATUSES)
        )
      )

    return rows
      .map((row) => ({
        id: row.payslipId,
        payrollPeriodLabel: row.payrollPeriodLabel,
        payrollPeriodStart: row.payrollPeriodStart,
        payrollPeriodEnd: row.payrollPeriodEnd,
        dtrCutOffStart: row.dtrCutOffStart,
        dtrCutOffEnd: row.dtrCutOffEnd,
        payoutDate: row.payoutDate,
        status: row.status,
      }))
      .sort((a, b) => b.payrollPeriodEnd.localeCompare(a.payrollPeriodEnd))
  })
}

function hasPayslipData(inputs: PayslipPayrollInputs): boolean {
  return Object.values(inputs).some(
    (value) => typeof value === "number" && value > 0
  )
}

function resolveStatusAfterSave(
  existingStatus: PayslipStatus,
  inputs: PayslipPayrollInputs
): PayslipStatus {
  if (!hasPayslipData(inputs)) {
    return "draft"
  }

  if (
    existingStatus === "adminApproved" ||
    existingStatus === "approved" ||
    existingStatus === "returned" ||
    existingStatus === "sent"
  ) {
    return "pending"
  }

  if (existingStatus === "draft") {
    return "pending"
  }

  return existingStatus
}

export async function backfillPayslipDraftStatuses(
  payrollId?: string,
  client: DatabaseClient = db
): Promise<number> {
  const conditions = [eq(payslips.status, "draft")]
  if (payrollId) {
    conditions.push(eq(payslips.payrollId, payrollId))
  }

  const rows = await client
    .select({
      id: payslips.id,
      inputs: payslipInputs.inputs,
    })
    .from(payslips)
    .innerJoin(payslipInputs, eq(payslipInputs.payslipId, payslips.id))
    .where(and(...conditions))

  let updated = 0

  for (const row of rows) {
    const inputs = {
      ...createEmptyPayslipInputs(),
      ...(row.inputs ?? {}),
    }

    if (!hasPayslipData(inputs)) {
      continue
    }

    await client
      .update(payslips)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(payslips.id, row.id))
    updated += 1
  }

  return updated
}

export async function createPayslipsForPayroll(
  payrollId: string,
  client: DatabaseClient = db
): Promise<number> {
  const payroll = await client.query.payrolls.findFirst({
    where: eq(payrollsTable.id, payrollId),
  })
  if (!payroll) {
    return 0
  }

  const employees = await getEmployees(client)
  const existingRows = await client
    .select({ employeeId: payslips.employeeId })
    .from(payslips)
    .where(eq(payslips.payrollId, payrollId))
  const existingEmployeeIds = new Set(
    existingRows.map((row) => row.employeeId)
  )
  const newPayslips = employees.filter(
    (employee) => !existingEmployeeIds.has(employee.employeeId)
  )

  if (newPayslips.length === 0) {
    return 0
  }

  const rows = newPayslips.map((employee) => ({
    id: crypto.randomUUID(),
    payrollId,
    employeeId: employee.employeeId,
    status: "draft" as const,
  }))
  await client.insert(payslips).values(rows)
  await client.insert(payslipInputs).values(
    rows.map((row, index) => {
      const employee = newPayslips[index]
      const inputs = derivePayslipInputsFromSchedule({
        employee,
        payroll,
        scheduleDays: [],
        existingInputs: createPayslipInputsWithBasicPay(employee.basicPay),
      })

      return {
        payslipId: row.id,
        inputs,
        totals: buildPayslipTotals(inputs, employee.divisor),
        updatedAt: new Date(),
      }
    })
  )

  return rows.length
}

export type NewPayslipInput = {
  payrollId: string
  employeeId: string
  inputs: PayslipPayrollInputs
}

export async function addPayslip(
  input: NewPayslipInput,
  client: DatabaseClient = db
): Promise<Payslip | { error: string }> {
  const payrollId = input.payrollId.trim()
  const employeeId = normalizeEmployeeId(input.employeeId)
  const payroll = await client.query.payrolls.findFirst({
    where: eq(payrollsTable.id, payrollId),
  })
  const employee = await findEmployeeByEmployeeId(employeeId, client)

  if (!payrollId || !payroll) {
    return { error: "Payroll period is required." }
  }

  if (!employee) {
    return { error: "No employee found with that Employee ID." }
  }

  const duplicate = await client.query.payslips.findFirst({
    where: and(
      eq(payslips.payrollId, payrollId),
      eq(payslips.employeeId, employeeId)
    ),
  })
  if (duplicate) {
    return {
      error: "A payslip for this employee and payroll period already exists.",
    }
  }

  const id = crypto.randomUUID()
  const inputs = await resolveDerivedPayslipInputs({
    employee,
    payroll,
    inputs: input.inputs,
    client,
  })
  const status: PayslipStatus = hasPayslipData(inputs) ? "pending" : "draft"
  const totals = buildPayslipTotals(inputs, employee.divisor)

  await client.insert(payslips).values({
    id,
    payrollId,
    employeeId,
    status,
    updatedAt: new Date(),
  })
  await client.insert(payslipInputs).values({
    payslipId: id,
    inputs,
    totals,
    updatedAt: new Date(),
  })

  const payslip = await getPayslipById(id, client)
  if (!payslip) {
    return { error: "Payslip not found." }
  }

  return payslip
}

export type UpdatePayslipInput = {
  id: string
  payrollId: string
  employeeId: string
  inputs: PayslipPayrollInputs
}

export async function updatePayslip(
  input: UpdatePayslipInput,
  client: DatabaseClient = db
): Promise<Payslip | { error: string }> {
  const existing = await getPayslipById(input.id, client)
  if (!existing) {
    return { error: "Payslip not found." }
  }

  const payrollId = input.payrollId.trim()
  const employeeId = normalizeEmployeeId(input.employeeId)
  const payroll = await client.query.payrolls.findFirst({
    where: eq(payrollsTable.id, payrollId),
  })
  const employee = await findEmployeeByEmployeeId(employeeId, client)

  if (!payrollId || !payroll) {
    return { error: "Payroll period is required." }
  }

  if (!employee) {
    return { error: "No employee found with that Employee ID." }
  }

  const duplicate = await client.query.payslips.findFirst({
    where: and(
      ne(payslips.id, input.id),
      eq(payslips.payrollId, payrollId),
      eq(payslips.employeeId, employeeId)
    ),
  })
  if (duplicate) {
    return {
      error: "A payslip for this employee and payroll period already exists.",
    }
  }

  const inputs = await resolveDerivedPayslipInputs({
    employee,
    payroll,
    inputs: input.inputs,
    client,
  })
  const status = resolveStatusAfterSave(existing.status, inputs)
  const totals = buildPayslipTotals(inputs, employee.divisor)

  await client
    .update(payslips)
    .set({
      payrollId,
      employeeId,
      status,
      updatedAt: new Date(),
    })
    .where(eq(payslips.id, input.id))
  await client
    .update(payslipInputs)
    .set({
      inputs,
      totals,
      updatedAt: new Date(),
    })
    .where(eq(payslipInputs.payslipId, input.id))

  const payslip = await getPayslipById(input.id, client)
  if (!payslip) {
    return { error: "Payslip not found." }
  }

  return payslip
}

export async function refreshPayslipFromSchedule(
  payrollId: string,
  employeeId: string,
  client: DatabaseClient = db
): Promise<Payslip | { error: string }> {
  const normalizedEmployeeId = normalizeEmployeeId(employeeId)
  const payroll = await client.query.payrolls.findFirst({
    where: eq(payrollsTable.id, payrollId),
  })
  const employee = await findEmployeeByEmployeeId(normalizedEmployeeId, client)
  const existing = await client.query.payslips.findFirst({
    where: and(
      eq(payslips.payrollId, payrollId),
      eq(payslips.employeeId, normalizedEmployeeId)
    ),
  })

  if (!payroll) {
    return { error: "Payroll not found." }
  }

  if (!employee) {
    return { error: "Employee not found." }
  }

  if (!existing) {
    return { error: "Employee payslip not found for this payroll period." }
  }

  const current = await getPayslipById(existing.id, client)
  if (!current) {
    return { error: "Payslip not found." }
  }

  const inputs = await resolveDerivedPayslipInputs({
    employee,
    payroll,
    inputs: current.inputs,
    client,
  })
  const status = resolveStatusAfterSave(current.status, inputs)
  const totals = buildPayslipTotals(inputs, employee.divisor)

  await client
    .update(payslips)
    .set({ status, updatedAt: new Date() })
    .where(eq(payslips.id, current.id))
  await client
    .update(payslipInputs)
    .set({ inputs, totals, updatedAt: new Date() })
    .where(eq(payslipInputs.payslipId, current.id))

  return {
    ...current,
    status,
    inputs,
    totals,
  }
}

export async function approvePayslipByAdmin(
  id: string,
  client: DatabaseClient = db
): Promise<Payslip | { error: string }> {
  const payslip = await getPayslipById(id, client)
  if (!payslip) {
    return { error: "Payslip not found." }
  }

  if (payslip.status !== "pending") {
    return { error: "Only payslips ready for review can be marked checked." }
  }

  if (!hasPayslipData(payslip.inputs)) {
    return { error: "Payslip must have payroll data before it can be checked." }
  }

  await client
    .update(payslips)
    .set({ status: "adminApproved", updatedAt: new Date() })
    .where(eq(payslips.id, id))

  return { ...payslip, status: "adminApproved" }
}

export async function approvePayslipBySuperAdmin(
  id: string,
  client: DatabaseClient = db
): Promise<Payslip | { error: string }> {
  const payslip = await getPayslipById(id, client)
  if (!payslip) {
    return { error: "Payslip not found." }
  }

  if (payslip.status !== "adminApproved") {
    return { error: "Only checked payslips can be released." }
  }

  await client
    .update(payslips)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(payslips.id, id))

  return { ...payslip, status: "approved" }
}

export async function returnPayslipByAdmin(
  id: string,
  client: DatabaseClient = db
): Promise<Payslip | { error: string }> {
  const payslip = await getPayslipById(id, client)
  if (!payslip) {
    return { error: "Payslip not found." }
  }

  if (payslip.status !== "pending") {
    return { error: "Only payslips ready for review can be returned." }
  }

  if (!hasPayslipData(payslip.inputs)) {
    return {
      error: "Payslip must have payroll data before it can be returned.",
    }
  }

  await client
    .update(payslips)
    .set({ status: "returned", updatedAt: new Date() })
    .where(eq(payslips.id, id))

  return { ...payslip, status: "returned" }
}

export async function returnPayslipBySuperAdmin(
  id: string,
  client: DatabaseClient = db
): Promise<Payslip | { error: string }> {
  const payslip = await getPayslipById(id, client)
  if (!payslip) {
    return { error: "Payslip not found." }
  }

  if (payslip.status !== "adminApproved") {
    return { error: "Only checked payslips can be returned." }
  }

  await client
    .update(payslips)
    .set({ status: "returned", updatedAt: new Date() })
    .where(eq(payslips.id, id))

  return { ...payslip, status: "returned" }
}

export async function deletePayslip(
  id: string,
  client: DatabaseClient = db
): Promise<{ success: true } | { error: string }> {
  const existing = await getPayslipById(id, client)
  if (!existing) {
    return { error: "Payslip not found." }
  }

  await client.delete(payslips).where(eq(payslips.id, id))
  return { success: true }
}
