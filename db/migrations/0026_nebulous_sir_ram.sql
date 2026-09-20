DROP INDEX "webhook_events_unprocessed_idx";--> statement-breakpoint
CREATE INDEX "conversation_events_actor_idx" ON "conversation_events" USING btree ("actor_agent_id");--> statement-breakpoint
CREATE INDEX "conversations_group_idx" ON "conversations" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "conversations_channel_id_idx" ON "conversations" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "messages_author_agent_idx" ON "messages" USING btree ("author_agent_id");--> statement-breakpoint
CREATE INDEX "messages_author_contact_idx" ON "messages" USING btree ("author_contact_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" is null;