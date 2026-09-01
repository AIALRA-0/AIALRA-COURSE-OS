import type { CourseRelease, LessonDraft, ReleaseManifest } from "@course-os/contracts";
import { sha256Text, stableStringify } from "@course-os/domain";
import type { ReadWeaveFileState } from "@course-os/readweave-adapter";

export interface PromotionConflict {
  objectType: "release" | "manifest" | "draft";
  objectId: string;
  code: string;
  localHash?: string;
  remoteHash?: string;
}

export interface PromotionPlan {
  selectedReleaseIds: string[];
  releasesToCreate: string[];
  draftsToCreate: Array<{ releaseId: string; pageId: string }>;
  unchangedReleaseIds: string[];
  conflicts: PromotionConflict[];
}

export function selectLatestFormalReleases(state: ReadWeaveFileState, explicitReleaseIds: string[] = []): CourseRelease[] {
  if (explicitReleaseIds.length) {
    const byId = new Map(state.releases.map((release) => [release.id, release]));
    return explicitReleaseIds.map((id) => {
      const release = byId.get(id);
      if (!release || release.lifecycle === "draft_source") throw new Error(`SOURCE_RELEASE_NOT_FOUND:${id}`);
      return release;
    });
  }
  const latest = new Map<string, CourseRelease>();
  for (const release of state.releases) {
    if (release.lifecycle === "draft_source" || isRegressionAsset(release)) continue;
    const key = `${release.courseId}\u0000${release.moduleId}`;
    const current = latest.get(key);
    if (!current || release.version > current.version || (release.version === current.version && release.publishedAt > current.publishedAt)) latest.set(key, release);
  }
  return [...latest.values()].sort((left, right) => left.courseId.localeCompare(right.courseId) || left.moduleId.localeCompare(right.moduleId));
}

export function buildPromotionPlan(
  state: ReadWeaveFileState,
  selected: CourseRelease[],
  remoteReleases: CourseRelease[],
  remoteManifests: Map<string, ReleaseManifest | undefined>,
  remoteDrafts: Map<string, LessonDraft | undefined>
): PromotionPlan {
  const plan: PromotionPlan = { selectedReleaseIds: selected.map((release) => release.id), releasesToCreate: [], draftsToCreate: [], unchangedReleaseIds: [], conflicts: [] };
  const remoteById = new Map(remoteReleases.map((release) => [release.id, release]));
  const localManifestByRelease = new Map(state.manifests.map((manifest) => [manifest.courseReleaseId, manifest]));

  for (const release of selected) {
    const localManifest = localManifestByRelease.get(release.id);
    if (!localManifest) {
      plan.conflicts.push({ objectType: "manifest", objectId: release.id, code: "LOCAL_MANIFEST_MISSING" });
      continue;
    }
    const remoteRelease = remoteById.get(release.id);
    if (!remoteRelease) {
      const occupiedDraft = release.pages.find((page) => remoteDrafts.get(page.id));
      if (occupiedDraft) {
        const remoteDraft = remoteDrafts.get(occupiedDraft.id)!;
        plan.conflicts.push({ objectType: "draft", objectId: occupiedDraft.id, code: "REMOTE_DRAFT_EXISTS_BEFORE_RELEASE", localHash: pageHash(occupiedDraft), remoteHash: pageHash(remoteDraft.page) });
      } else {
        plan.releasesToCreate.push(release.id);
      }
      continue;
    }
    const remoteManifest = remoteManifests.get(release.id);
    if (!remoteManifest) {
      plan.conflicts.push({ objectType: "manifest", objectId: release.id, code: "REMOTE_MANIFEST_MISSING", localHash: objectHash(localManifest) });
      continue;
    }
    const localHash = releaseHash(release, localManifest);
    const remoteHash = releaseHash(remoteRelease, remoteManifest);
    if (localHash !== remoteHash) {
      plan.conflicts.push({ objectType: "release", objectId: release.id, code: "SAME_ID_DIFFERENT_HASH", localHash, remoteHash });
      continue;
    }
    plan.unchangedReleaseIds.push(release.id);
    for (const page of release.pages) {
      const remoteDraft = remoteDrafts.get(page.id);
      if (!remoteDraft) {
        plan.draftsToCreate.push({ releaseId: release.id, pageId: page.id });
        continue;
      }
      const localPageHash = pageHash(page);
      const remotePageHash = pageHash(remoteDraft.page);
      if (localPageHash !== remotePageHash) plan.conflicts.push({ objectType: "draft", objectId: page.id, code: "SAME_PAGE_DIFFERENT_HASH", localHash: localPageHash, remoteHash: remotePageHash });
    }
  }
  return plan;
}

export function releaseHash(release: CourseRelease, manifest: ReleaseManifest): string {
  return objectHash({ release: { ...release, lifecycle: "published" }, manifest });
}

export function pageHash(page: CourseRelease["pages"][number]): string {
  return objectHash(page);
}

function objectHash(value: unknown): string {
  return sha256Text(stableStringify(value));
}

function isRegressionAsset(release: CourseRelease): boolean {
  return /(synthetic|golden|regression|legacy|test-course)/i.test(`${release.id} ${release.courseId} ${release.courseTitle} ${release.moduleTitle}`);
}
