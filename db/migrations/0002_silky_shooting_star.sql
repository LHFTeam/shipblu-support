CREATE INDEX "conversation_events_type_idx" ON "conversation_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "conversations_created_idx" ON "conversations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversations_resolved_idx" ON "conversations" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "conversations_first_responded_idx" ON "conversations" USING btree ("first_responded_at");--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at");