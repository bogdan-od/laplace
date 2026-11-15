import { Transform } from 'class-transformer';

/** Trims a string value; other types are left for the validators to reject. */
export const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Trims and lower-cases (logins and invite codes are case-insensitive input). */
export const TrimLower = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

export const TrimUpper = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );
