package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// setupGitRepo creates a temp dir with an initialized git repo.
func setupGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git setup failed (%v): %s", args, string(out))
		}
	}

	// Create initial commit
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test\n"), 0644)
	cmd := exec.Command("git", "add", "-A")
	cmd.Dir = dir
	cmd.CombinedOutput()
	cmd = exec.Command("git", "commit", "-m", "initial commit")
	cmd.Dir = dir
	cmd.CombinedOutput()

	return dir
}

func TestIsGitRepo(t *testing.T) {
	dir := setupGitRepo(t)
	if !isGitRepo(dir) {
		t.Error("expected isGitRepo=true for git-initialized dir")
	}

	notGit := t.TempDir()
	if isGitRepo(notGit) {
		t.Error("expected isGitRepo=false for non-git dir")
	}
}

func TestGitStatus(t *testing.T) {
	dir := setupGitRepo(t)

	// Clean repo
	out, ok := toolGitStatus(nil, dir)
	if !ok {
		t.Fatalf("git_status failed: %s", out)
	}

	// Add an untracked file
	os.WriteFile(filepath.Join(dir, "new.txt"), []byte("hello"), 0644)
	out, ok = toolGitStatus(nil, dir)
	if !ok {
		t.Fatalf("git_status failed: %s", out)
	}
	if !strings.Contains(out, "new.txt") {
		t.Errorf("expected new.txt in status, got: %s", out)
	}
}

func TestGitStatusNotGitRepo(t *testing.T) {
	dir := t.TempDir()
	out, ok := toolGitStatus(nil, dir)
	if ok {
		t.Error("expected failure for non-git dir")
	}
	if !strings.Contains(out, "not a git repository") {
		t.Errorf("expected 'not a git repository' error, got: %s", out)
	}
}

func TestGitDiff(t *testing.T) {
	dir := setupGitRepo(t)

	// Modify a tracked file
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Changed\n"), 0644)

	out, ok := toolGitDiff(map[string]interface{}{}, dir)
	if !ok {
		t.Fatalf("git_diff failed: %s", out)
	}
	if !strings.Contains(out, "Changed") {
		t.Errorf("expected diff to contain 'Changed', got: %s", out)
	}
}

func TestGitDiffStaged(t *testing.T) {
	dir := setupGitRepo(t)

	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Staged\n"), 0644)
	cmd := exec.Command("git", "add", "README.md")
	cmd.Dir = dir
	cmd.CombinedOutput()

	out, ok := toolGitDiff(map[string]interface{}{"staged": true}, dir)
	if !ok {
		t.Fatalf("git_diff --cached failed: %s", out)
	}
	if !strings.Contains(out, "Staged") {
		t.Errorf("expected staged diff to contain 'Staged', got: %s", out)
	}
}

func TestGitDiffNoDiff(t *testing.T) {
	dir := setupGitRepo(t)
	out, ok := toolGitDiff(map[string]interface{}{}, dir)
	if !ok {
		t.Fatalf("git_diff failed: %s", out)
	}
	if !strings.Contains(out, "No differences") {
		t.Errorf("expected 'No differences', got: %s", out)
	}
}

func TestGitLog(t *testing.T) {
	dir := setupGitRepo(t)

	out, ok := toolGitLog(map[string]interface{}{}, dir)
	if !ok {
		t.Fatalf("git_log failed: %s", out)
	}
	if !strings.Contains(out, "initial commit") {
		t.Errorf("expected 'initial commit' in log, got: %s", out)
	}
}

func TestGitLogOneline(t *testing.T) {
	dir := setupGitRepo(t)

	out, ok := toolGitLog(map[string]interface{}{"oneline": true}, dir)
	if !ok {
		t.Fatalf("git_log --oneline failed: %s", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 1 {
		t.Errorf("expected 1 line in oneline log, got %d", len(lines))
	}
}

func TestGitLogCount(t *testing.T) {
	dir := setupGitRepo(t)

	// Add more commits
	for i := 0; i < 5; i++ {
		os.WriteFile(filepath.Join(dir, "README.md"), []byte(strings.Repeat("x", i+1)), 0644)
		cmd := exec.Command("git", "add", "-A")
		cmd.Dir = dir
		cmd.CombinedOutput()
		cmd = exec.Command("git", "commit", "-m", "commit "+strings.Repeat("x", i+1))
		cmd.Dir = dir
		cmd.CombinedOutput()
	}

	out, ok := toolGitLog(map[string]interface{}{"count": float64(3), "oneline": true}, dir)
	if !ok {
		t.Fatalf("git_log with count failed: %s", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 {
		t.Errorf("expected 3 lines, got %d: %s", len(lines), out)
	}
}

func TestGitCommit(t *testing.T) {
	dir := setupGitRepo(t)

	// Create a file and commit it
	os.WriteFile(filepath.Join(dir, "test.go"), []byte("package main\n"), 0644)

	out, ok := toolGitCommit(map[string]interface{}{
		"message":   "add test.go",
		"stage_all": true,
	}, dir)
	if !ok {
		t.Fatalf("git_commit failed: %s", out)
	}
	if !strings.Contains(out, "add test.go") {
		t.Errorf("expected commit message in output, got: %s", out)
	}

	// Verify commit exists in log
	logOut, ok := toolGitLog(map[string]interface{}{"oneline": true, "count": float64(1)}, dir)
	if !ok {
		t.Fatalf("git_log after commit failed: %s", logOut)
	}
	if !strings.Contains(logOut, "add test.go") {
		t.Errorf("commit not in log: %s", logOut)
	}
}

func TestGitCommitSpecificFiles(t *testing.T) {
	dir := setupGitRepo(t)

	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa"), 0644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("bbb"), 0644)

	out, ok := toolGitCommit(map[string]interface{}{
		"message": "add only a.txt",
		"files":   []interface{}{"a.txt"},
	}, dir)
	if !ok {
		t.Fatalf("git_commit failed: %s", out)
	}

	// b.txt should still be untracked
	statusOut, _ := toolGitStatus(nil, dir)
	if !strings.Contains(statusOut, "b.txt") {
		t.Error("b.txt should still be untracked")
	}
}

func TestGitCommitNoMessage(t *testing.T) {
	dir := setupGitRepo(t)
	out, ok := toolGitCommit(map[string]interface{}{}, dir)
	if ok {
		t.Error("git_commit without message should fail")
	}
	if !strings.Contains(out, "commit message is required") {
		t.Errorf("expected error about missing message, got: %s", out)
	}
}

func TestGitBranchList(t *testing.T) {
	dir := setupGitRepo(t)
	out, ok := toolGitBranch(map[string]interface{}{}, dir)
	if !ok {
		t.Fatalf("git_branch list failed: %s", out)
	}
	if !strings.Contains(out, "master") && !strings.Contains(out, "main") {
		t.Errorf("expected master/main in branch list, got: %s", out)
	}
}

func TestGitBranchCreate(t *testing.T) {
	dir := setupGitRepo(t)
	out, ok := toolGitBranch(map[string]interface{}{
		"name":   "feature-test",
		"create": true,
	}, dir)
	if !ok {
		t.Fatalf("git_branch create failed: %s", out)
	}
	if !strings.Contains(out, "feature-test") {
		t.Errorf("expected branch name in output, got: %s", out)
	}

	// Verify we're on the new branch
	listOut, _ := toolGitBranch(map[string]interface{}{}, dir)
	if !strings.Contains(listOut, "feature-test") {
		t.Errorf("new branch not in list: %s", listOut)
	}
}

func TestGitBranchSwitch(t *testing.T) {
	dir := setupGitRepo(t)

	// Create a branch first
	toolGitBranch(map[string]interface{}{"name": "other", "create": true}, dir)

	// Switch back to master/main
	// Determine default branch name
	defaultBranch := "master"
	cmd := exec.Command("git", "branch", "--list", "main")
	cmd.Dir = dir
	if out, _ := cmd.Output(); strings.TrimSpace(string(out)) != "" {
		defaultBranch = "main"
	}

	out, ok := toolGitBranch(map[string]interface{}{"name": defaultBranch}, dir)
	if !ok {
		t.Fatalf("git_branch switch failed: %s", out)
	}
	if !strings.Contains(out, defaultBranch) {
		t.Errorf("expected branch name in output, got: %s", out)
	}
}

func TestGitToolsInToolDefs(t *testing.T) {
	gitTools := []string{"git_status", "git_diff", "git_log", "git_commit", "git_branch"}
	for _, name := range gitTools {
		found := false
		for _, td := range toolDefs {
			if td.Function.Name == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("git tool %q not found in toolDefs", name)
		}
	}
}

func TestGitToolsParallelSafe(t *testing.T) {
	readOnly := []string{"git_status", "git_diff", "git_log"}
	for _, name := range readOnly {
		if !IsParallelSafe(name) {
			t.Errorf("%s should be parallel-safe", name)
		}
	}

	mutating := []string{"git_commit", "git_branch"}
	for _, name := range mutating {
		if IsParallelSafe(name) {
			t.Errorf("%s should NOT be parallel-safe", name)
		}
	}
}

func TestGitToolsInSubagent(t *testing.T) {
	allowed := map[string]bool{"git_status": false, "git_diff": false, "git_log": false}
	for _, td := range subagentToolDefs {
		if _, ok := allowed[td.Function.Name]; ok {
			allowed[td.Function.Name] = true
		}
	}
	for name, found := range allowed {
		if !found {
			t.Errorf("%s should be in subagent tool defs", name)
		}
	}

	// git_commit and git_branch should NOT be in subagent
	for _, td := range subagentToolDefs {
		if td.Function.Name == "git_commit" || td.Function.Name == "git_branch" {
			t.Errorf("%s should NOT be in subagent tool defs", td.Function.Name)
		}
	}
}
