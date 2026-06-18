DROP INDEX "contacts_last_meeting_idx";--> statement-breakpoint
DROP INDEX "contacts_last_email_idx";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "last_meeting_at";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "last_email_at";