export interface Character {
  id: string;
  name: string;
  description: string;
  imageUrl?: string;
  seasonId: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "eliminated";
}

export interface Story {
  id: string;
  content: string;
  imageUrl?: string;
  seasonId: string;
  page: number;
  createdAt: string;
  updatedAt: string;
}

export interface Season {
  id: string;
  name: string;
  isCurrent: boolean;
  isPlaying: boolean;
  biome: string;
  winnerId?: string;
  createdAt: string;
  updatedAt: string;
}

// Optional: Helper type for normalized data
export interface NormalizedData<T> {
  byId: { [key: string]: T };
  allIds: string[];
}
