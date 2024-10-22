import { User } from "./services/messages";

export interface Channel {
  id: number;
  server_id: string;
  name: string;
  is_thread: boolean;
  parent_channel_id?: string;
}

export interface EmojiReaction {
  emoji: string;
  user_id: string;
  count: number;
}

export interface UrlMetadata {
  type: string;
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface Message {
  id: string;
  channel_id: string;
  user: User;
  parent_id?: string; // Add this line
  content: string;
  embeds?: UrlMetadata[];
  reactions: EmojiReaction[];
  created_at: Date;
  updated_at: Date;
  parent_preview?: Message; // Add this line
  wallet_address?: string; // Add this line
}
