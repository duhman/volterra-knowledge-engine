export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ampeco_changelog_notifications: {
        Row: {
          id: number
          notified_at: string | null
          slack_response: Json | null
          version: string
        }
        Insert: {
          id?: number
          notified_at?: string | null
          slack_response?: Json | null
          version: string
        }
        Update: {
          id?: number
          notified_at?: string | null
          slack_response?: Json | null
          version?: string
        }
        Relationships: []
      }
      ampeco_changelog_state: {
        Row: {
          created_at: string | null
          id: number
          last_checked_at: string | null
          last_notified_at: string | null
          last_seen_version: string | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          last_checked_at?: string | null
          last_notified_at?: string | null
          last_seen_version?: string | null
        }
        Update: {
          created_at?: string | null
          id?: number
          last_checked_at?: string | null
          last_notified_at?: string | null
          last_seen_version?: string | null
        }
        Relationships: []
      }
      gpt_api_keys: {
        Row: {
          allowed_schemas: string[]
          api_key: string
          created_at: string | null
          gpt_name: string
          id: string
          is_active: boolean | null
          last_used_at: string | null
          rate_limit_per_minute: number | null
        }
        Insert: {
          allowed_schemas?: string[]
          api_key: string
          created_at?: string | null
          gpt_name: string
          id?: string
          is_active?: boolean | null
          last_used_at?: string | null
          rate_limit_per_minute?: number | null
        }
        Update: {
          allowed_schemas?: string[]
          api_key?: string
          created_at?: string | null
          gpt_name?: string
          id?: string
          is_active?: boolean | null
          last_used_at?: string | null
          rate_limit_per_minute?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      cron_job: {
        Row: {
          active: boolean | null
          command: string | null
          database: string | null
          jobid: number | null
          jobname: string | null
          nodename: string | null
          nodeport: number | null
          schedule: string | null
          username: string | null
        }
        Insert: {
          active?: boolean | null
          command?: string | null
          database?: string | null
          jobid?: number | null
          jobname?: string | null
          nodename?: string | null
          nodeport?: number | null
          schedule?: string | null
          username?: string | null
        }
        Update: {
          active?: boolean | null
          command?: string | null
          database?: string | null
          jobid?: number | null
          jobname?: string | null
          nodename?: string | null
          nodeport?: number | null
          schedule?: string | null
          username?: string | null
        }
        Relationships: []
      }
      cron_job_run_details: {
        Row: {
          command: string | null
          database: string | null
          end_time: string | null
          job_pid: number | null
          jobid: number | null
          jobname: string | null
          return_message: string | null
          runid: number | null
          start_time: string | null
          status: string | null
          username: string | null
        }
        Relationships: []
      }
      cron_job_status: {
        Row: {
          active: boolean | null
          command: string | null
          database: string | null
          end_time: string | null
          job_pid: number | null
          jobid: number | null
          jobname: string | null
          nodename: string | null
          nodeport: number | null
          return_message: string | null
          runid: number | null
          schedule: string | null
          start_time: string | null
          status: string | null
          username: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      asset_map_get_facilities_for_geocoding: {
        Args: { p_country?: string; p_limit?: number }
        Returns: {
          address: string
          city: string
          country: string
          id: string
          name: string
          postal_code: string
        }[]
      }
      asset_map_get_facilities_for_sync: {
        Args: { p_country?: string; p_limit?: number }
        Returns: {
          address: string
          city: string
          country: string
          hubspot_id: string
          id: string
          name: string
          postal_code: string
        }[]
      }
      asset_map_get_geocode_stats: {
        Args: never
        Returns: {
          denmark_needs: number
          geocoded: number
          needs_geocoding: number
          no_address: number
          norway_needs: number
          sweden_needs: number
          total_facilities: number
        }[]
      }
      asset_map_update_facility_from_hubspot: {
        Args: {
          p_address: string
          p_city: string
          p_facility_id: string
          p_hubspot_id: string
          p_postal_code: string
        }
        Returns: undefined
      }
      asset_map_update_facility_geocode: {
        Args: {
          p_facility_id: string
          p_geocode_confidence?: number
          p_geocode_status?: string
          p_latitude?: number
          p_longitude?: number
        }
        Returns: undefined
      }
      backfill_slack_user_names_from_raw: {
        Args: never
        Returns: {
          skipped_count: number
          updated_count: number
        }[]
      }
      cron_health: { Args: never; Returns: Json }
      exec_sql: { Args: { query: string }; Returns: Json }
      get_cron_job_runs: {
        Args: { p_jobname?: string; p_limit?: number }
        Returns: {
          command: string
          database: string
          end_time: string
          job_pid: number
          jobid: number
          return_message: string
          runid: number
          start_time: string
          status: string
          username: string
        }[]
      }
      get_facilities: {
        Args: {
          p_countries?: string[]
          p_geocoded_only?: boolean
          p_limit?: number
          p_offset?: number
          p_search?: string
        }
        Returns: {
          address: string
          charger_count: number
          city: string
          country: string
          created_at: string
          geocode_confidence: number
          geocode_status: string
          hubspot_id: string
          id: string
          latitude: number
          longitude: number
          name: string
          postal_code: string
          updated_at: string
        }[]
      }
      get_facility_stats: { Args: never; Returns: Json }
      get_facility_with_chargers: {
        Args: { p_facility_id: string }
        Returns: Json
      }
      get_last_job_run: {
        Args: { p_jobname: string }
        Returns: {
          command: string
          database: string
          end_time: string
          job_pid: number
          jobid: number
          return_message: string
          runid: number
          start_time: string
          status: string
          username: string
        }[]
      }
      get_latest_slack_messages: {
        Args: { p_channel_id?: string; p_limit?: number }
        Returns: {
          bot_id: string
          channel_id: string
          file_count: number
          has_files: boolean
          id: string
          message_at: string
          message_ts: string
          subtype: string
          text: string
          thread_ts: string
          user_display_name: string
          user_id: string
          user_real_name: string
        }[]
      }
      get_latest_training_conversations: {
        Args: {
          category_filter?: string
          result_limit?: number
          status_filter?: string
        }
        Returns: {
          content: string
          id: string
          metadata: Json
        }[]
      }
      get_private_databases: {
        Args: never
        Returns: {
          database_type: string
          name: string
          notion_database_id: string
          target_schema: string
        }[]
      }
      get_project_url: { Args: never; Returns: string }
      get_reaction_analytics: {
        Args: {
          p_channel_id?: string
          p_date_from?: string
          p_date_to?: string
        }
        Returns: {
          avg_reactions_per_message: number
          messages_with_reactions: number
          top_reactions: Json
          total_messages: number
          total_reactions: number
        }[]
      }
      get_service_role_key: { Args: never; Returns: string }
      get_slack_channel_summary: {
        Args: { p_channel_id?: string; p_days?: number }
        Returns: {
          channel_id: string
          earliest_message: string
          latest_message: string
          messages_in_period: number
          threads_in_period: number
          total_messages: number
          unique_users: number
        }[]
      }
      get_slack_messages_by_date: {
        Args: {
          p_channel_id?: string
          p_date_from?: string
          p_date_to?: string
          p_limit?: number
        }
        Returns: {
          bot_id: string
          channel_id: string
          file_count: number
          has_files: boolean
          id: string
          message_at: string
          message_ts: string
          subtype: string
          text: string
          thread_ts: string
          user_display_name: string
          user_id: string
          user_real_name: string
        }[]
      }
      get_slack_thread_messages: {
        Args: { p_channel_id?: string; p_thread_ts: string }
        Returns: {
          bot_id: string
          channel_id: string
          file_count: number
          has_files: boolean
          id: string
          is_root: boolean
          message_at: string
          message_ts: string
          subtype: string
          text: string
          thread_ts: string
          user_display_name: string
          user_id: string
          user_real_name: string
        }[]
      }
      google_ads_get_accounts: {
        Args: never
        Returns: {
          campaign_count: number
          currency_code: string
          customer_id: string
          descriptive_name: string
          id: number
          time_zone: string
          updated_at: string
        }[]
      }
      google_ads_get_campaign_ids: {
        Args: never
        Returns: {
          campaign_id: string
          id: number
        }[]
      }
      google_ads_get_campaigns: {
        Args: {
          p_customer_id: string
          p_end_date?: string
          p_start_date?: string
        }
        Returns: {
          budget_amount_micros: number
          campaign_id: string
          clicks: number
          conversion_value: number
          conversions: number
          cost_micros: number
          cpa_micros: number
          cpc_micros: number
          ctr: number
          impressions: number
          name: string
          roas: number
          status: string
          type: string
        }[]
      }
      google_ads_get_insights: {
        Args: {
          p_customer_id: string
          p_end_date?: string
          p_start_date?: string
        }
        Returns: {
          active_campaigns: number
          avg_cpa_micros: number
          avg_cpc_micros: number
          avg_ctr: number
          overall_roas: number
          total_budget_micros: number
          total_clicks: number
          total_conversion_value: number
          total_conversions: number
          total_cost_micros: number
          total_impressions: number
        }[]
      }
      google_ads_get_keywords: {
        Args: {
          p_customer_id: string
          p_end_date?: string
          p_limit?: number
          p_order_by?: string
          p_start_date?: string
        }
        Returns: {
          ad_group_name: string
          campaign_name: string
          clicks: number
          conversion_value: number
          conversions: number
          cost_micros: number
          cpa_micros: number
          cpc_micros: number
          ctr: number
          impressions: number
          keyword_id: string
          keyword_text: string
          match_type: string
        }[]
      }
      google_ads_upsert_account: {
        Args: {
          p_currency_code?: string
          p_customer_id: string
          p_descriptive_name?: string
          p_manager_customer_id?: string
          p_time_zone?: string
        }
        Returns: number
      }
      google_ads_upsert_campaign: {
        Args: {
          p_account_id: number
          p_budget_amount_micros?: number
          p_campaign_id: string
          p_end_date?: string
          p_name?: string
          p_start_date?: string
          p_status?: string
          p_type?: string
        }
        Returns: number
      }
      google_ads_upsert_keyword: {
        Args: {
          p_ad_group_id?: string
          p_ad_group_name?: string
          p_campaign_id: number
          p_keyword_id: string
          p_keyword_text?: string
          p_match_type?: string
          p_status?: string
        }
        Returns: number
      }
      google_ads_upsert_keyword_metric: {
        Args: {
          p_clicks?: number
          p_conversion_value?: number
          p_conversions?: number
          p_cost_micros?: number
          p_date: string
          p_impressions?: number
          p_keyword_id: number
        }
        Returns: number
      }
      google_ads_upsert_metric: {
        Args: {
          p_campaign_id: number
          p_clicks?: number
          p_conversion_value?: number
          p_conversions?: number
          p_cost_micros?: number
          p_date: string
          p_impressions?: number
        }
        Returns: number
      }
      import_chargers: { Args: { p_chargers: Json }; Returns: number }
      import_facilities: {
        Args: { p_facilities: Json }
        Returns: {
          facility_id: string
          facility_name: string
        }[]
      }
      insert_dd_document: {
        Args: {
          p_category?: string
          p_citations?: Json
          p_content: string
          p_doc_type?: string
          p_embedding: string
          p_id?: string
          p_keywords?: string[]
          p_market?: string
          p_question?: string
          p_section?: string
          p_source_file?: string
          p_title: string
        }
        Returns: string
      }
      insert_leadership_coach_document: {
        Args: {
          p_checksum?: string
          p_chunk: string
          p_embedding: string
          p_metadata?: Json
          p_source: string
          p_source_id: string
          p_title: string
        }
        Returns: string
      }
      list_cron_jobs: {
        Args: never
        Returns: {
          active: boolean
          command: string
          database: string
          jobid: number
          jobname: string
          nodename: string
          nodeport: number
          schedule: string
          username: string
        }[]
      }
      match_dd_documents: {
        Args: {
          filter_category?: string
          filter_market?: string
          match_count?: number
          query_embedding: string
        }
        Returns: {
          category: string
          citations: Json
          content: string
          id: string
          market: string
          question: string
          similarity: number
          title: string
        }[]
      }
      match_documents:
        | {
            Args: {
              filter?: Json
              match_count?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
        | {
            Args: {
              match_count?: number
              match_threshold?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
      match_hubspot_tickets: {
        Args: { filter?: Json; match_count?: number; query_embedding: string }
        Returns: {
          category: string
          content: string
          create_date: string
          customer_name: string
          hubspot_link: string
          id: string
          message_count: number
          priority: string
          similarity: number
          subcategory: string
          subject: string
          ticket_id: string
        }[]
      }
      match_leadership_coach_documents: {
        Args: { filter?: Json; match_count?: number; query_embedding: string }
        Returns: {
          chunk: string
          id: string
          metadata: Json
          similarity: number
          source: string
          source_id: string
          title: string
        }[]
      }
      match_slack_messages:
        | {
            Args: {
              filter?: Json
              match_count?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
        | {
            Args: {
              match_count?: number
              match_threshold?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
      match_slack_messages_by_channel: {
        Args: {
          match_count?: number
          match_threshold?: number
          p_channel_id?: string
          query_embedding: string
        }
        Returns: {
          channel_id: string
          id: string
          message_at: string
          message_ts: string
          similarity: number
          text: string
          thread_ts: string
          user_display_name: string
        }[]
      }
      match_slack_threads: {
        Args: { filter?: Json; match_count?: number; query_embedding: string }
        Returns: {
          channel_id: string
          channel_name: string
          content: string
          date_end: string
          date_start: string
          id: string
          message_count: number
          participants: string[]
          root_author: string
          similarity: number
          slack_link: string
          thread_ts: string
        }[]
      }
      match_training_conversations:
        | {
            Args: {
              filter?: Json
              match_count?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
        | {
            Args: {
              match_count?: number
              match_threshold?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
      match_wod_deals:
        | {
            Args: {
              filter?: Json
              match_count?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
        | {
            Args: {
              match_count?: number
              match_threshold?: number
              query_embedding: string
            }
            Returns: {
              content: string
              id: string
              metadata: Json
              similarity: number
            }[]
          }
      private_kb_document_exists: {
        Args: { p_content_hash: string }
        Returns: boolean
      }
      private_kb_get_document_by_source: {
        Args: { p_source_path: string; p_source_type: string }
        Returns: {
          content_hash: string
          id: string
        }[]
      }
      private_kb_get_sync_status: {
        Args: never
        Returns: {
          document_count: number
          last_error: string
          last_sync_at: string
          pages_created: number
          pages_processed: number
          pages_updated: number
        }[]
      }
      private_kb_update_sync_state: {
        Args: {
          p_last_error?: string
          p_pages_created: number
          p_pages_processed: number
          p_pages_updated: number
        }
        Returns: undefined
      }
      private_kb_upsert_document: {
        Args: {
          p_content: string
          p_content_hash?: string
          p_document_type: string
          p_embedding: string
          p_notion_database_id?: string
          p_notion_page_id?: string
          p_source_path: string
          p_source_type: string
          p_tags?: string[]
          p_title: string
        }
        Returns: {
          created: boolean
          id: string
        }[]
      }
      query_raw: { Args: { sql_query: string }; Returns: Json[] }
      refresh_housing_associations_cache: { Args: never; Returns: undefined }
      upsert_slack_thread: {
        Args: {
          p_channel_id: string
          p_channel_name: string
          p_checksum: string
          p_content: string
          p_date_end: string
          p_date_start: string
          p_embedding: string
          p_message_count: number
          p_participants: string[]
          p_root_author: string
          p_slack_link: string
          p_thread_ts: string
        }
        Returns: string
      }
      upsert_ticket_transcript: {
        Args: {
          p_category?: string
          p_checksum?: string
          p_content: string
          p_create_date?: string
          p_embedding: string
          p_hubspot_link?: string
          p_message_count?: number
          p_priority?: string
          p_subject: string
          p_ticket_id: string
        }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
