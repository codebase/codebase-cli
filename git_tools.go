package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// ──────────────────────────────────────────────────────────────
//  Git tools — first-class git integration
// ──────────────────────────────────────────────────────────────

func init() {
	gitTools := []ToolDef{
		{
			Type: "function",
			Function: ToolDefFunction{
				Name:        "git_status",
				Description: "Show the working tree status: staged, unstaged, and untracked files. Use this before making commits to see what has changed.",
				Parameters: map[string]interface{}{
					"type":       "object",
					"properties": map[string]interface{}{},
					"required":   []string{},
				},
			},
		},
		{
			Type: "function",
			Function: ToolDefFunction{
				Name:        "git_diff",
				Description: "Show file differences. By default shows unstaged changes. Use staged=true for staged changes, or specify a ref to diff against.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"staged": map[string]interface{}{
							"type":        "boolean",
							"description": "If true, show staged (--cached) changes.",
						},
						"ref": map[string]interface{}{
							"type":        "string",
							"description": "Git ref to diff against (e.g. HEAD~3, main, a commit hash).",
						},
						"path": map[string]interface{}{
							"type":        "string",
							"description": "Limit diff to a specific file or directory.",
						},
					},
					"required": []string{},
				},
			},
		},
		{
			Type: "function",
			Function: ToolDefFunction{
				Name:        "git_log",
				Description: "Show recent commit history. Returns commit hash, author, date, and message.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"count": map[string]interface{}{
							"type":        "number",
							"description": "Number of commits to show (default 10, max 50).",
						},
						"oneline": map[string]interface{}{
							"type":        "boolean",
							"description": "If true, show compact one-line format.",
						},
						"path": map[string]interface{}{
							"type":        "string",
							"description": "Show commits that modified this file/directory.",
						},
					},
					"required": []string{},
				},
			},
		},
		{
			Type: "function",
			Function: ToolDefFunction{
				Name:        "git_commit",
				Description: "Stage files and create a git commit. Specify files to stage, or use stage_all=true to stage all changes. The commit message is required.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"message": map[string]interface{}{
							"type":        "string",
							"description": "Commit message.",
						},
						"files": map[string]interface{}{
							"type":        "array",
							"description": "Files to stage before committing (relative to project root).",
							"items": map[string]interface{}{
								"type": "string",
							},
						},
						"stage_all": map[string]interface{}{
							"type":        "boolean",
							"description": "If true, stage all changes (git add -A) before committing.",
						},
					},
					"required": []string{"message"},
				},
			},
		},
		{
			Type: "function",
			Function: ToolDefFunction{
				Name:        "git_branch",
				Description: "List, create, or switch branches. Without arguments, lists all local branches. With name, creates or switches to that branch.",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"name": map[string]interface{}{
							"type":        "string",
							"description": "Branch name to create or switch to.",
						},
						"create": map[string]interface{}{
							"type":        "boolean",
							"description": "If true, create a new branch (git checkout -b).",
						},
					},
					"required": []string{},
				},
			},
		},
	}
	toolDefs = append(toolDefs, gitTools...)

	// Register read-only git tools as parallel-safe
	parallelSafeTools["git_status"] = true
	parallelSafeTools["git_diff"] = true
	parallelSafeTools["git_log"] = true
}

// isGitRepo checks if workDir is inside a git repository.
func isGitRepo(workDir string) bool {
	cmd := exec.Command("git", "rev-parse", "--is-inside-work-tree")
	cmd.Dir = workDir
	out, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

func toolGitStatus(args map[string]interface{}, workDir string) (string, bool) {
	if !isGitRepo(workDir) {
		return "Error: not a git repository", false
	}
	cmd := exec.Command("git", "status", "--short", "--branch")
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("Error: %s\n%s", err, string(out)), false
	}
	result := strings.TrimSpace(string(out))
	if result == "" {
		return "No changes (clean working tree)", true
	}
	return result, true
}

func toolGitDiff(args map[string]interface{}, workDir string) (string, bool) {
	if !isGitRepo(workDir) {
		return "Error: not a git repository", false
	}
	gitArgs := []string{"diff", "--no-color"}
	if getBool(args, "staged") {
		gitArgs = append(gitArgs, "--cached")
	}
	if ref := getString(args, "ref"); ref != "" {
		gitArgs = append(gitArgs, ref)
	}
	if path := getString(args, "path"); path != "" {
		gitArgs = append(gitArgs, "--", path)
	}

	cmd := exec.Command("git", gitArgs...)
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("Error: %s\n%s", err, string(out)), false
	}
	result := strings.TrimSpace(string(out))
	if result == "" {
		return "No differences found", true
	}
	return truncateOutput(result), true
}

func toolGitLog(args map[string]interface{}, workDir string) (string, bool) {
	if !isGitRepo(workDir) {
		return "Error: not a git repository", false
	}
	count := 10
	if c, ok := getFloat(args, "count"); ok && c > 0 {
		count = int(c)
		if count > 50 {
			count = 50
		}
	}

	format := "--format=%H %an (%ar)%n  %s"
	if getBool(args, "oneline") {
		format = "--format=%h %s (%ar)"
	}

	gitArgs := []string{"log", format, fmt.Sprintf("-n%d", count), "--no-color"}
	if path := getString(args, "path"); path != "" {
		gitArgs = append(gitArgs, "--", path)
	}

	cmd := exec.Command("git", gitArgs...)
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("Error: %s\n%s", err, string(out)), false
	}
	return truncateOutput(strings.TrimSpace(string(out))), true
}

func toolGitCommit(args map[string]interface{}, workDir string) (string, bool) {
	if !isGitRepo(workDir) {
		return "Error: not a git repository", false
	}
	message := getString(args, "message")
	if message == "" {
		return "Error: commit message is required", false
	}

	// Stage files
	if getBool(args, "stage_all") {
		cmd := exec.Command("git", "add", "-A")
		cmd.Dir = workDir
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Sprintf("Error staging: %s\n%s", err, string(out)), false
		}
	} else if filesRaw, ok := args["files"]; ok {
		filesJSON, _ := json.Marshal(filesRaw)
		var files []string
		json.Unmarshal(filesJSON, &files)
		for _, f := range files {
			cmd := exec.Command("git", "add", "--", f)
			cmd.Dir = workDir
			if out, err := cmd.CombinedOutput(); err != nil {
				return fmt.Sprintf("Error staging %s: %s\n%s", f, err, string(out)), false
			}
		}
	}

	// Commit
	cmd := exec.Command("git", "commit", "-m", message)
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("Error: %s\n%s", err, string(out)), false
	}
	return strings.TrimSpace(string(out)), true
}

func toolGitBranch(args map[string]interface{}, workDir string) (string, bool) {
	if !isGitRepo(workDir) {
		return "Error: not a git repository", false
	}
	name := getString(args, "name")

	if name == "" {
		// List branches
		cmd := exec.Command("git", "branch", "-v", "--no-color")
		cmd.Dir = workDir
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Sprintf("Error: %s\n%s", err, string(out)), false
		}
		return strings.TrimSpace(string(out)), true
	}

	if getBool(args, "create") {
		cmd := exec.Command("git", "checkout", "-b", name)
		cmd.Dir = workDir
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Sprintf("Error: %s\n%s", err, string(out)), false
		}
		return fmt.Sprintf("Created and switched to branch: %s\n%s", name, strings.TrimSpace(string(out))), true
	}

	// Switch to existing branch
	cmd := exec.Command("git", "switch", name)
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("Error: %s\n%s", err, string(out)), false
	}
	return fmt.Sprintf("Switched to branch: %s\n%s", name, strings.TrimSpace(string(out))), true
}
