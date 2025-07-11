-- Add recordingUrl column to call_history table
-- This fixes the schema validation error: PGRST204 - Could not find the 'recordingUrl' column
-- Note: Using snake_case (recording_url) as per PostgreSQL conventions
-- Supabase automatically converts camelCase JS field names to snake_case column names

ALTER TABLE public.call_history 
ADD COLUMN recording_url TEXT;

-- Add comment for the new column
COMMENT ON COLUMN public.call_history.recording_url IS 'URL to the Twilio call recording, if available';