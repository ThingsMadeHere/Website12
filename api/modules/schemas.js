'use strict';
// ── input validation (zod) ───────────────────────────────────────────────────
// All request-body schemas live here so route modules share one vocabulary of
// shapes. Replaces hand-rolled typeof/regex checks scattered across the routes.
// Usage: const [data, errResponse] = validate(LoginSchema, req, res);

const { z } = require('zod');

function validate(schema, req, res) {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({ error: `${first.path.join('.') || 'body'}: ${first.message}` });
    return [null, undefined];
  }
  return [parsed.data, null];
}

const UsernameSchema = z.string().trim().toLowerCase()
  .min(1, 'required').max(32, 'may be at most 32 characters')
  .regex(/^[a-z0-9._-]+$/, 'may only contain letters, numbers, and . _ - characters');

const LoginSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(1, 'required').max(200),
});

const JoinLoginSchema = z.object({
  username: z.string().trim().toLowerCase().min(3).max(20)
    .regex(/^[a-z0-9_]+$/, 'Usernames: 3–20 letters, numbers, or underscores.'),
  key: z.string().min(1, 'Enter the team key.').max(100),
});

const PasswordResetSchema = z.object({
  username: UsernameSchema,
  currentPassword: z.string().min(1, 'required').max(200),
  newPassword: z.string().min(6, 'New password must be at least 6 characters').max(200),
});

const PhotoSchema = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  data: z.string().min(64, 'Photo data is invalid'),
});

const ApplicationSchema = z.object({
  username: UsernameSchema,
  fullName: z.string().trim().min(1, 'Full name is required').max(80),
  photo: PhotoSchema.optional(),
});

const NotificationSettingsSchema = z.object({
  settings: z.enum(['all', 'mentions_only', 'none']),
});

const ProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(80),
});

const AvailabilitySchema = z.object({
  title: z.string().max(120).optional().nullable(),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/, 'date must look like 2026-04-10 or 2026-04-10T16:00'),
  startTime: z.string().regex(/^([0-9]{2}:[0-9]{2})?$/, 'HH:MM').optional().nullable(),
  endTime: z.string().regex(/^([0-9]{2}:[0-9]{2})?$/, 'HH:MM').optional().nullable(),
  location: z.string().max(120).optional().nullable(),
  repeatType: z.enum(['none', 'weekly', 'monthly']).optional().default('none'),
}).refine(d => d.date, { message: 'Date is required' });

const EventCreateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().max(5000).optional().default(''),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/, 'date must look like 2026-04-10 or 2026-04-10T16:00'),
  location: z.string().max(200).optional().default(''),
  type: z.enum(['meeting', 'event', 'workshop', 'competition']).optional().default('meeting'),
  push: z.boolean().optional().default(false),
});

const EventUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200).optional(),
  description: z.string().max(5000).optional(),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/, 'date must look like 2026-04-10 or 2026-04-10T16:00').optional(),
  location: z.string().max(200).optional(),
  type: z.enum(['meeting', 'event', 'workshop', 'competition']).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

const VoteSchema = z.object({ vote: z.union([z.literal(1), z.literal(-1)]) });

const DecisionSchema = z.object({ action: z.enum(['approve', 'deny']) });

const AdminUserCreateSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(6, 'Password must be at least 6 characters').max(200),
  fullName: z.string().trim().max(80).optional().default(''),
  photo: PhotoSchema.nullable().optional(),
  tags: z.array(z.any()).optional().default([]),
  verified: z.boolean().optional(),
  mustChangePassword: z.boolean().optional().default(false),
});

const AdminUserPatchSchema = z.object({
  username: UsernameSchema.optional(),
  fullName: z.string().trim().max(80).optional(),
  verified: z.boolean().optional(),
  password: z.string().min(6, 'Password must be at least 6 characters').max(200).optional(),
  mustChangePassword: z.boolean().optional(),
  photo: PhotoSchema.nullable().optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' });

const TimeoutSchema = z.object({
  minutes: z.number().int().min(1, 'minutes must be between 1 and 527040 (1 year)')
    .max(60 * 24 * 366, 'minutes must be between 1 and 527040 (1 year)').optional(),
  until: z.string().datetime({ offset: true }).or(z.string().min(4)).optional(),
  clear: z.boolean().optional(),
});

const JoinKeySetSchema = z.object({
  key: z.string().min(6, 'The team key should be at least 6 characters (letters and numbers).').max(100),
  label: z.string().max(60).optional().default(''),
  days: z.number().int().min(1).max(365).optional(),
});

const PushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url('Invalid subscription object').max(2048),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).partial().optional(),
  }),
});

module.exports = {
  validate,
  UsernameSchema,
  LoginSchema,
  JoinLoginSchema,
  PasswordResetSchema,
  PhotoSchema,
  ApplicationSchema,
  NotificationSettingsSchema,
  ProfileSchema,
  AvailabilitySchema,
  EventCreateSchema,
  EventUpdateSchema,
  VoteSchema,
  DecisionSchema,
  AdminUserCreateSchema,
  AdminUserPatchSchema,
  TimeoutSchema,
  JoinKeySetSchema,
  PushSubscribeSchema,
};
