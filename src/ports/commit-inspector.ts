export interface CommitInspector {
  exists(repoPath: string, ref: string): boolean;
  files(repoPath: string, ref: string, baseCommit?: string): string[];
  contains(repoPath: string, ancestor: string, descendant: string): boolean;
}
