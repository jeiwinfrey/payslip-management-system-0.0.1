import { config } from "dotenv"

config()
config({ path: ".env.local", override: true })

import bcrypt from "bcryptjs"
import { eq } from "drizzle-orm"

import { closeDb, db } from "@/db"
import { users } from "@/db/schema"
import { getEmployees } from "@/lib/employees"
import { seedUsers } from "@/lib/seed-users"
import { createUserAccount, encryptInitialPassword } from "@/lib/users"

async function backfillSeedUsers() {
  let created = 0
  let updated = 0

  for (const seedUser of seedUsers) {
    const existing = await db.query.users.findFirst({
      where: eq(users.employeeId, seedUser.employeeId),
    })
    const initialPasswordCiphertext = encryptInitialPassword(seedUser.password)

    if (!existing) {
      await db.insert(users).values({
        employeeId: seedUser.employeeId,
        email: seedUser.email,
        role: seedUser.role,
        passwordHash: await bcrypt.hash(seedUser.password, 10),
        initialPasswordCiphertext,
        passwordChangedAt: null,
        updatedAt: new Date(),
      })
      created += 1
      continue
    }

    await db
      .update(users)
      .set({
        email: seedUser.email,
        initialPasswordCiphertext:
          existing.initialPasswordCiphertext ?? initialPasswordCiphertext,
        updatedAt: new Date(),
      })
      .where(eq(users.employeeId, seedUser.employeeId))
    updated += 1
  }

  return { created, updated }
}

async function main() {
  const seedResult = await backfillSeedUsers()
  const employees = await getEmployees()
  const created: Array<{
    employeeId: string
    email: string
    initialPassword: string
  }> = []
  let skipped = 0

  for (const employee of employees) {
    const existing = await db.query.users.findFirst({
      where: eq(users.employeeId, employee.employeeId),
    })
    if (existing) {
      skipped += 1
      continue
    }

    const result = await createUserAccount({
      employeeId: employee.employeeId,
      email: employee.email,
      role: "employee",
    })
    if ("error" in result) {
      throw new Error(`${employee.employeeId}: ${result.error}`)
    }

    created.push({
      employeeId: result.user.employeeId,
      email: result.user.email,
      initialPassword: result.initialPassword,
    })
  }

  console.log(`Employee user backfill complete.`)
  console.log(`Seed users created: ${seedResult.created}`)
  console.log(`Seed users updated: ${seedResult.updated}`)
  console.log(`Created: ${created.length}`)
  console.log(`Skipped existing: ${skipped}`)
  if (created.length > 0) {
    console.table(created)
  }
}

main()
  .then(() => closeDb())
  .catch((error) => {
    console.error(error)
    closeDb().finally(() => process.exit(1))
  })
