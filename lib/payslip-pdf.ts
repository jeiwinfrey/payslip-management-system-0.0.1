import fs from "fs"
import path from "path"
import PDFDocument from "pdfkit/js/pdfkit.standalone.js"

import {
  DEDUCTION_FIELDS,
  NON_TAXABLE_ADJUSTMENT_FIELDS,
  NON_TAXABLE_ADJUSTMENT_PAIRS,
  NON_TAXABLE_PDF_FIELDS,
  PAY_DETAILS_FIELDS,
  type PayslipFieldDefinition,
} from "@/lib/payslip-fields"
import { calculatePayslipTotals, formatAttendanceDuration } from "@/lib/payroll-calculator"
import { formatDisplayDate } from "@/lib/payroll-dates"
import type { PayslipPayrollInputs, PayslipPdfData } from "@/lib/types"

const PAGE_MARGIN = 36
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2
const BLOCK_GAP = 0
const LOGO_HEIGHT = 52

const DARK_GREEN = "#166534"

const GRID_ROW_COUNT =
  1 + PAY_DETAILS_FIELDS.length + 1.5 + NON_TAXABLE_PDF_FIELDS.length + 1.5 + 1

const COLUMN_WIDTHS = {
  payItem: 0.21,
  days: 0.1,
  hrs: 0.08,
  amount: 0.15,
  middle: 0.06,
  dedItem: 0.24,
  dedAmount: 0.16,
} as const

function formatSampleAmount(value: number | undefined) {
  if (value === undefined || value === 0) {
    return "-"
  }

  const formatted = Math.abs(value).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  return value < 0 ? `(${formatted})` : formatted
}

function formatSampleQty(value: number | undefined) {
  if (value === undefined || value === 0) {
    return "-"
  }

  return value.toLocaleString("en-PH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

function formatSampleDtr(start: string, end: string) {
  return `${formatDisplayDate(start)}-${formatDisplayDate(end)}`
}

function rawFieldValue(
  inputs: PayslipPayrollInputs,
  field: PayslipFieldDefinition
) {
  return inputs[field.key as keyof PayslipPayrollInputs]
}

function getPayAmount(
  field: PayslipFieldDefinition,
  value: number,
  lineAmounts: Record<string, number>
) {
  return lineAmounts[field.key] ?? value
}

function getAdjLabel(field: PayslipFieldDefinition) {
  const pair = NON_TAXABLE_ADJUSTMENT_PAIRS.find(
    ({ baseKey }) => baseKey === field.key
  )
  const adjField = NON_TAXABLE_ADJUSTMENT_FIELDS.find(
    (candidate) => candidate.key === pair?.adjKey
  )

  return adjField?.label ?? null
}

function getAdjValue(
  inputs: PayslipPayrollInputs,
  field: PayslipFieldDefinition
) {
  const pair = NON_TAXABLE_ADJUSTMENT_PAIRS.find(
    ({ baseKey }) => baseKey === field.key
  )

  return pair ? inputs[pair.adjKey] : undefined
}

function getAttendanceMinutes(data: PayslipPdfData, fieldKey: string) {
  if (fieldKey === "tardiness") {
    return data.attendance.tardinessMinutes
  }
  if (fieldKey === "undertime") {
    return data.attendance.undertimeMinutes
  }
  return undefined
}

function collectPdf(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)
    doc.end()
  })
}

function columnX(startX: number, ...keys: (keyof typeof COLUMN_WIDTHS)[]) {
  let x = startX
  for (const key of keys) {
    x += CONTENT_WIDTH * COLUMN_WIDTHS[key]
  }
  return x
}

function rowTextY(y: number, rowHeight: number, fontSize: number) {
  return y + (rowHeight - fontSize) / 2
}

const LOGO_PATH = path.join(process.cwd(), "public", "helport.png")
let cachedLogoBuffer: Buffer | null | undefined

function getLogoBuffer() {
  if (cachedLogoBuffer !== undefined) {
    return cachedLogoBuffer
  }

  if (!fs.existsSync(LOGO_PATH)) {
    cachedLogoBuffer = null
    return cachedLogoBuffer
  }

  cachedLogoBuffer = fs.readFileSync(LOGO_PATH)
  return cachedLogoBuffer
}

function drawSampleHeader(
  doc: PDFKit.PDFDocument,
  data: PayslipPdfData,
  y: number
) {
  // Outer Border is drawn separately

  const logoTop = y + 5
  const logoBuffer = getLogoBuffer()

  if (logoBuffer) {
    doc.image(logoBuffer, PAGE_MARGIN + 10, logoTop, { height: LOGO_HEIGHT })
  }

  const payrollTitleY = logoTop + LOGO_HEIGHT + 6

  doc
    .font("Helvetica-BoldOblique")
    .fontSize(8)
    .fillColor(DARK_GREEN)
    .text(
      "HELPORT PHILIPPINES BRANCH OFFICE PAYROLL",
      PAGE_MARGIN + 10,
      payrollTitleY
    )

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#000000")
    .text("EMPLOYEE NAME:", PAGE_MARGIN + 10, payrollTitleY + 15)
  doc
    .font("Helvetica-Oblique")
    .fontSize(8)
    .fillColor("#000000")
    .text(data.employeeName, PAGE_MARGIN + 100, payrollTitleY + 15)

  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#000000")
    .text("EMPLOYEE ID:", PAGE_MARGIN + 10, payrollTitleY + 30)
  doc
    .font("Helvetica-Oblique")
    .fontSize(8)
    .fillColor("#000000")
    .text(data.employeeId, PAGE_MARGIN + 100, payrollTitleY + 30)

  const rightX = PAGE_WIDTH / 2 + 30
  const rightValX = rightX + 80
  const lineH = 12
  let currY = y + 10

  const drawRightItem = (label: string, value: string) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor("#000000")
      .text(label, rightX, currY)
    doc
      .font("Helvetica-Oblique")
      .fontSize(8)
      .fillColor("#000000")
      .text(value, rightValX, currY)
    currY += lineH
  }

  drawRightItem("PAYROLL PERIOD:", data.payrollPeriodLabel)
  drawRightItem(
    "DTR CUT-OFF:",
    formatSampleDtr(data.dtrCutOffStart, data.dtrCutOffEnd)
  )
  drawRightItem("TIN:", data.tin || "-")
  drawRightItem("SSS NO.:", data.sssNo || "-")
  drawRightItem("PHIC NO.:", data.phicNo || "-")
  drawRightItem("HDMF NO.:", data.hdmfNo || "-")

  const headerBottomY = Math.max(payrollTitleY + 40, currY + 5)

  // Separator line between header and table
  doc
    .moveTo(PAGE_MARGIN, headerBottomY)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, headerBottomY)
    .lineWidth(1)
    .strokeColor(DARK_GREEN)
    .undash()
    .stroke()

  return headerBottomY
}

function getColumnBounds(x: number) {
  const payItem = x
  const days = columnX(x, "payItem")
  const hrs = columnX(x, "payItem", "days")
  const amount = columnX(x, "payItem", "days", "hrs")
  const middle = columnX(x, "payItem", "days", "hrs", "amount")
  const dedItem = columnX(x, "payItem", "days", "hrs", "amount", "middle")
  const dedAmount = columnX(
    x,
    "payItem",
    "days",
    "hrs",
    "amount",
    "middle",
    "dedItem"
  )

  return {
    payItem,
    days,
    hrs,
    amount,
    middle,
    dedItem,
    dedAmount,
    payItemW: CONTENT_WIDTH * COLUMN_WIDTHS.payItem,
    daysW: CONTENT_WIDTH * COLUMN_WIDTHS.days,
    hrsW: CONTENT_WIDTH * COLUMN_WIDTHS.hrs,
    amountW: CONTENT_WIDTH * COLUMN_WIDTHS.amount,
    middleW: CONTENT_WIDTH * COLUMN_WIDTHS.middle,
    dedItemW: CONTENT_WIDTH * COLUMN_WIDTHS.dedItem,
    dedAmountW: CONTENT_WIDTH * COLUMN_WIDTHS.dedAmount,
  }
}

function drawMainGrid({
  doc,
  data,
  inputs,
  lineAmounts,
  x,
  y,
  height,
}: {
  doc: PDFKit.PDFDocument
  data: PayslipPdfData
  inputs: PayslipPayrollInputs
  lineAmounts: Record<string, number>
  x: number
  y: number
  height: number
}) {
  const rowHeight = height / GRID_ROW_COUNT
  const cols = getColumnBounds(x)
  let rowY = y

  const drawGridLines = (currentY: number) => {
    doc
      .moveTo(x, currentY)
      .lineTo(x + CONTENT_WIDTH, currentY)
      .lineWidth(0.5)
      .strokeColor(DARK_GREEN)
      .dash(2, { space: 2 })
      .stroke()
  }

  const headerY = rowTextY(rowY, rowHeight, 8)
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000")
  doc.text("Pay Details", cols.payItem + 2, headerY, {
    width: cols.payItemW - 4,
  })
  doc.text("Days", cols.days + 2, headerY, {
    width: cols.daysW - 4,
    align: "center",
  })
  doc.text("Hrs", cols.hrs + 2, headerY, {
    width: cols.hrsW - 4,
    align: "center",
  })
  doc.text("Amount", cols.amount + 2, headerY, {
    width: cols.amountW - 4,
    align: "center",
  })
  doc.text("Deductions", cols.dedItem + 2, headerY, {
    width: cols.dedItemW - 4,
  })
  doc.text("Amount", cols.dedAmount + 2, headerY, {
    width: cols.dedAmountW - 4,
    align: "center",
  })

  rowY += rowHeight
  drawGridLines(rowY)

  for (const [index, field] of PAY_DETAILS_FIELDS.entries()) {
    const textY = rowTextY(rowY, rowHeight, 8)
    const val = rawFieldValue(inputs, field)
    const amount =
      typeof val === "number" ? getPayAmount(field, val, lineAmounts) : 0
    const attendanceMinutes = getAttendanceMinutes(data, field.key)
    const dedField = DEDUCTION_FIELDS[index]
    const dedVal = dedField ? rawFieldValue(inputs, dedField) : undefined

    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#000000")
    doc.text(field.label, cols.payItem + 2, textY, {
      width: cols.payItemW - 4,
      lineBreak: false,
      ellipsis: true,
    })

    doc.font("Helvetica").fontSize(8).fillColor("#000000")
    if (typeof val !== "number") {
      doc.text("-", cols.days, textY, { width: cols.daysW - 4, align: "right" })
      doc.text("-", cols.hrs, textY, { width: cols.hrsW - 4, align: "right" })
      doc.text("-", cols.amount, textY, {
        width: cols.amountW - 4,
        align: "right",
      })
    } else {
      if (field.inputKind === "days") {
        doc.text(formatSampleQty(val), cols.days, textY, {
          width: cols.daysW - 4,
          align: "right",
        })
        doc.text("-", cols.hrs, textY, { width: cols.hrsW - 4, align: "right" })
      } else if (field.inputKind === "hours" || attendanceMinutes !== undefined) {
        doc.text("-", cols.days, textY, {
          width: cols.daysW - 4,
          align: "right",
        })
        const hrsMinutes = attendanceMinutes ?? Math.round(val * 60)
        doc.text(
          formatAttendanceDuration(hrsMinutes),
          cols.hrs,
          textY,
          {
            width: cols.hrsW - 4,
            align: "right",
          }
        )
      } else {
        doc.text("-", cols.days, textY, {
          width: cols.daysW - 4,
          align: "right",
        })
        doc.text("-", cols.hrs, textY, { width: cols.hrsW - 4, align: "right" })
      }
      doc.fillColor(amount < 0 ? "#FF0000" : "#000000")
      doc.text(formatSampleAmount(amount), cols.amount, textY, {
        width: cols.amountW - 4,
        align: "right",
      })
    }

    if (dedField) {
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#000000")
      doc.text(dedField.label, cols.dedItem + 2, textY, {
        width: cols.dedItemW - 4,
        lineBreak: false,
        ellipsis: true,
      })
      doc.font("Helvetica").fontSize(8).fillColor("#000000")
      doc.text(
        typeof dedVal === "number" && dedVal !== 0
          ? formatSampleAmount(dedVal)
          : "-",
        cols.dedAmount,
        textY,
        { width: cols.dedAmountW - 4, align: "right" }
      )
    }

    rowY += rowHeight
    drawGridLines(rowY)
  }

  const taxableRowHeight = rowHeight * 1.5
  const subY = rowTextY(rowY, taxableRowHeight, 8)
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000")
  doc.text("TAXABLE", cols.payItem + 2, subY - 4, { width: cols.payItemW - 4 })
  doc.text("EARNINGS", cols.payItem + 2, subY + 4, { width: cols.payItemW - 4 })
  doc.text(formatSampleAmount(data.totals.taxableEarnings), cols.amount, subY, {
    width: cols.amountW - 4,
    align: "right",
  })

  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000")
  doc.text("TOTAL", cols.dedItem + 2, subY - 4, { width: cols.dedItemW - 4 })
  doc.text("DEDUCTIONS", cols.dedItem + 2, subY + 4, {
    width: cols.dedItemW - 4,
  })
  doc.text(
    formatSampleAmount(data.totals.totalDeductions),
    cols.dedAmount,
    subY,
    { width: cols.dedAmountW - 4, align: "right" }
  )

  rowY += taxableRowHeight
  drawGridLines(rowY)

  for (const field of NON_TAXABLE_PDF_FIELDS) {
    const textY = rowTextY(rowY, rowHeight, 8)
    const val = rawFieldValue(inputs, field)
    const adjLabel = getAdjLabel(field)
    const adjVal = getAdjValue(inputs, field)

    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#000000")
    doc.text(field.label, cols.payItem + 2, textY, {
      width: cols.payItemW - 4,
      lineBreak: false,
      ellipsis: true,
    })
    doc.font("Helvetica").fontSize(8).fillColor("#000000")
    doc.text("-", cols.days, textY, { width: cols.daysW - 4, align: "right" })
    doc.text("-", cols.hrs, textY, { width: cols.hrsW - 4, align: "right" })
    doc.text(
      typeof val === "number" && val !== 0 ? formatSampleAmount(val) : "-",
      cols.amount,
      textY,
      { width: cols.amountW - 4, align: "right" }
    )

    if (adjLabel) {
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#000000")
      doc.text(adjLabel, cols.dedItem + 2, textY, {
        width: cols.dedItemW - 4,
        lineBreak: false,
        ellipsis: true,
      })
      doc.font("Helvetica").fontSize(8).fillColor("#000000")
      doc.fillColor(typeof adjVal === "number" && adjVal < 0 ? "#FF0000" : "#000000")
      doc.text(
        typeof adjVal === "number" && adjVal !== 0
          ? formatSampleAmount(adjVal)
          : "-",
        cols.dedAmount,
        textY,
        {
          width: cols.dedAmountW - 4,
          align: "right",
        }
      )
    }
    rowY += rowHeight
    drawGridLines(rowY)
  }

  const ntRowHeight = rowHeight * 1.5
  const ntY = rowTextY(rowY, ntRowHeight, 8)
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000")
  doc.text("NON-TAXABLE", cols.payItem + 2, ntY - 4, {
    width: cols.payItemW - 4,
  })
  doc.text("EARNINGS", cols.payItem + 2, ntY + 4, { width: cols.payItemW - 4 })
  doc.text(
    formatSampleAmount(data.totals.nonTaxableEarnings),
    cols.amount,
    ntY,
    { width: cols.amountW - 4, align: "right" }
  )

  rowY += ntRowHeight

  doc
    .moveTo(x, rowY)
    .lineTo(x + CONTENT_WIDTH, rowY)
    .lineWidth(1)
    .strokeColor(DARK_GREEN)
    .undash()
    .stroke()

  const gY = rowTextY(rowY, rowHeight, 8)
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000")
  doc.text("GROSS PAY", cols.payItem + 2, gY, { width: cols.payItemW - 4 })
  doc.text(formatSampleAmount(data.totals.grossPay), cols.amount, gY, {
    width: cols.amountW - 4,
    align: "right",
  })

  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000")
  doc.text("NET PAY", cols.dedItem + 2, gY, { width: cols.dedItemW - 4 })
  doc.text(formatSampleAmount(data.totals.netPay), cols.dedAmount, gY, {
    width: cols.dedAmountW - 4,
    align: "right",
  })

  rowY += rowHeight

  // Draw Vertical lines for the grid
  const drawVerticalLine = (lineX: number) => {
    doc
      .moveTo(lineX, y)
      .lineTo(lineX, rowY)
      .lineWidth(0.5)
      .strokeColor(DARK_GREEN)
      .dash(2, { space: 2 })
      .stroke()
  }

  drawVerticalLine(cols.days)
  drawVerticalLine(cols.hrs)
  drawVerticalLine(cols.amount)
  drawVerticalLine(cols.middle)
  drawVerticalLine(cols.dedItem)
  drawVerticalLine(cols.dedAmount)

  doc.undash()
}

function drawSampleFooter(
  doc: PDFKit.PDFDocument,
  data: PayslipPdfData,
  y: number
) {
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000")
  doc.text(" Payout Date:", PAGE_MARGIN, y + 15, { width: 70 })
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#000000")
  doc.text(formatDisplayDate(data.payoutDate), PAGE_MARGIN + 65, y + 15)

  doc.font("Helvetica-Bold").fontSize(7).fillColor(DARK_GREEN)
  doc.text("HELPORT PHILIPPINES BRANCH OFFICE", PAGE_WIDTH / 2 + 30, y + 25)
}

export async function buildPasswordLockedPayslipPdf(
  data: PayslipPdfData,
  password: string
) {
  const doc = new PDFDocument({
    size: "LETTER",
    layout: "portrait",
    margin: 0,
    pdfVersion: "1.7ext3",
    userPassword: password,
    ownerPassword: crypto.randomUUID(),
    permissions: {
      printing: "highResolution",
      modifying: false,
      copying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: true,
      documentAssembly: false,
    },
    info: {
      Title: `Payslip - ${data.payrollPeriodLabel}`,
      Author: "Helport Payroll",
      Subject: `Payslip for ${data.employeeName}`,
    },
  })

  // Outer border
  doc
    .rect(
      PAGE_MARGIN,
      PAGE_MARGIN,
      CONTENT_WIDTH,
      PAGE_HEIGHT - 2 * PAGE_MARGIN
    )
    .lineWidth(1)
    .strokeColor(DARK_GREEN)
    .undash()
    .stroke()

  const cursorY = drawSampleHeader(doc, data, PAGE_MARGIN) + BLOCK_GAP

  const footerY = PAGE_HEIGHT - PAGE_MARGIN - 40

  // Footer border line
  doc
    .moveTo(PAGE_MARGIN, footerY)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, footerY)
    .lineWidth(1)
    .strokeColor(DARK_GREEN)
    .undash()
    .stroke()

  const gridHeight = footerY - BLOCK_GAP - cursorY

  const calculation = calculatePayslipTotals(data.inputs, data.employeeDivisor)

  drawMainGrid({
    doc,
    data,
    inputs: data.inputs,
    lineAmounts: calculation.lineAmounts,
    x: PAGE_MARGIN,
    y: cursorY,
    height: gridHeight,
  })

  drawSampleFooter(doc, data, footerY)

  return collectPdf(doc)
}
