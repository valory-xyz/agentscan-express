-- Create stories table
CREATE TABLE public.stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  image_url TEXT,
  season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on season_id and page for faster queries
CREATE INDEX idx_stories_season_id_page ON public.stories(season_id, page);

-- Revert changes if needed
-- DROP TABLE public.stories;
