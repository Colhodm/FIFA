import { assetUrl } from '../audio/audio';
import type { TeamData, TeamsFile } from '../types';

/**
 * Team content is data, not code: drop another entry into public/data/teams.json and it shows
 * up in the team select. Swap the file for a licensed import when rights are cleared.
 */
export async function loadTeams(): Promise<TeamData[]> {
  const res = await fetch(assetUrl('data/teams.json'));
  if (!res.ok) throw new Error(`Failed to load teams (${res.status})`);
  const file = (await res.json()) as TeamsFile;
  if (!Array.isArray(file.teams) || file.teams.length < 2) {
    throw new Error('teams.json must contain at least two teams');
  }
  return file.teams;
}
