import { requireDaemon, hostOmpVersion, ensureImage } from './docker.mjs';
import { resolveModel, requireKey } from './registry.mjs';
import { GRADING_KEY, requireGradingKey } from './jev.mjs';

export async function doctor({ modelAlias, out = s => process.stdout.write(s + '\n') }) {
  await requireDaemon();
  out('docker: daemon is up');
  requireGradingKey();
  out(`grading key: ${GRADING_KEY} is set`);
  const m = resolveModel(modelAlias);
  requireKey(m);
  out(`model: ${m.alias} -> ${m.model} (${m.env} is set)`);
  const v = await hostOmpVersion();
  const { tag, built } = await ensureImage(v);
  out(built ? `image: ${tag} built` : `image: ${tag} already exists`);
  return { model: m, ompVersion: v, image: tag };
}
