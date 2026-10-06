// Local record of house sessions (spec 2026-10-05 §4.3). The world map files
// stay on this phone only (no resuming on another device -- YAGNI).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import type { House } from './houseSession';

const INDEX = 'houses.v1';
const key = (id: string) => `house:${id}`;

export function worldMapPath(propertyId: string, mapId: string): string {
  return `${FileSystem.documentDirectory}houses/${propertyId}/${mapId}.arexperience`;
}

export function newMapId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function readIndex(): Promise<string[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(INDEX)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export async function saveHouse(h: House): Promise<void> {
  await AsyncStorage.setItem(key(h.propertyId), JSON.stringify(h));
  const ids = await readIndex();
  if (!ids.includes(h.propertyId)) await AsyncStorage.setItem(INDEX, JSON.stringify([h.propertyId, ...ids]));
}

export async function loadHouse(propertyId: string): Promise<House | null> {
  const raw = await AsyncStorage.getItem(key(propertyId));
  return raw ? (JSON.parse(raw) as House) : null;
}

export async function listLocalHouses(): Promise<House[]> {
  const out: House[] = [];
  for (const id of await readIndex()) {
    const h = await loadHouse(id);
    if (h) out.push(h);
  }
  return out;
}

export async function removeHouse(propertyId: string): Promise<void> {
  await AsyncStorage.removeItem(key(propertyId));
  await AsyncStorage.setItem(INDEX, JSON.stringify((await readIndex()).filter((i) => i !== propertyId)));
  await FileSystem.deleteAsync(`${FileSystem.documentDirectory}houses/${propertyId}`, { idempotent: true });
}
