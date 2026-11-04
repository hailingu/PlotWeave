/** Compiler contracts for domain/schema evolution; no source-text or layout checks (#946). */
import type { NormalizedShapeSchema } from './normalizedGraphShape'

type Expect<T extends true> = T
type Reject<T extends false> = T
type Extends<A, B> = A extends B ? true : false
type TextGuard = (value: unknown) => value is string
type NumberGuard = (value: unknown) => value is number

type Model = { name: string; count?: number }
type Complete = {
  name: { guard: TextGuard; optional: false }
  count: { guard: NumberGuard; optional: true }
}

/** Valid schemas distinguish missing optional values from missing validator entries. */
export type CompleteSchemaIsAccepted = Expect<
  Extends<Complete, NormalizedShapeSchema<Model>>
>
export type MissingRequiredValidatorIsRejected = Reject<
  Extends<Pick<Complete, 'count'>, NormalizedShapeSchema<Model>>
>
export type MissingOptionalValidatorIsRejected = Reject<
  Extends<Pick<Complete, 'name'>, NormalizedShapeSchema<Model>>
>

/** Required fields cannot be made optional, and guards cannot silently change field types. */
export type OptionalRequiredFieldIsRejected = Reject<
  Extends<
    {
      name: { guard: TextGuard; optional: true }
      count: Complete['count']
    },
    NormalizedShapeSchema<Model>
  >
>
export type WrongFieldGuardIsRejected = Reject<
  Extends<
    {
      name: { guard: NumberGuard; optional: false }
      count: Complete['count']
    },
    NormalizedShapeSchema<Model>
  >
>

/** Both kinds of later field additions force the old schema to be updated. */
export type AddedRequiredFieldRejectsOldSchema = Reject<
  Extends<Complete, NormalizedShapeSchema<Model & { later: boolean }>>
>
export type AddedOptionalFieldRejectsOldSchema = Reject<
  Extends<Complete, NormalizedShapeSchema<Model & { later?: boolean }>>
>
