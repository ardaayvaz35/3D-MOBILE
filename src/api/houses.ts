// House rows (spec 2026-10-05 §4.4). Writes go through Edge Functions;
// reads straight from `properties` under RLS (owner only).
import { supabase } from '../lib/supabase';

export type PropertyRow = { id: string; name: string; status: string; room_count: number; created_at: string };

export async function createProperty(name: string): Promise<{ property_id: string; name: string }> {
  const { data, error } = await supabase.functions.invoke('create-property', { body: { name } });
  if (error || !data?.property_id) throw new Error(`Ev oluşturulamadı: ${error?.message ?? 'yanıt boş'}`);
  return { property_id: data.property_id, name: data.name };
}

export async function finishProperty(propertyId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('finish-property', { body: { property_id: propertyId } });
  if (error) throw new Error(`Ev bitirilemedi: ${error.message}`);
}

export async function listProperties(): Promise<PropertyRow[]> {
  const { data, error } = await supabase
    .from('properties')
    .select('id, name, status, room_count, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Evler alınamadı: ${error.message}`);
  return (data ?? []) as PropertyRow[];
}
