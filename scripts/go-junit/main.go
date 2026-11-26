// go-junit runs gotestsum and maps its package-based JUnit identities to test files.
// It deliberately refuses identities it cannot map uniquely.
package main

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type junit struct {
	XMLName xml.Name   `xml:"testsuites"`
	Attrs   []xml.Attr `xml:",any,attr"`
	Suites  []suite    `xml:"testsuite"`
}
type suite struct {
	Attrs []xml.Attr `xml:",any,attr"`
	Cases []testcase `xml:"testcase"`
}
type testcase struct {
	Attrs   []xml.Attr `xml:",any,attr"`
	Content string     `xml:",innerxml"`
}
type pkg struct {
	Dir          string
	ImportPath   string
	TestGoFiles  []string
	XTestGoFiles []string
}

func attr(attrs []xml.Attr, name string) string {
	for _, a := range attrs {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}
func setAttr(attrs []xml.Attr, name, value string) []xml.Attr {
	for i := range attrs {
		if attrs[i].Name.Local == name {
			attrs[i].Value = value
			return attrs
		}
	}
	return append(attrs, xml.Attr{Name: xml.Name{Local: name}, Value: value})
}

func indexTests(root string) (map[string][]string, error) {
	cmd := exec.Command("go", "list", "-json", "./...")
	cmd.Stderr = os.Stderr
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list: %w", err)
	}
	dec := json.NewDecoder(strings.NewReader(string(output)))
	result := map[string][]string{}
	for {
		var p pkg
		if err := dec.Decode(&p); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, err
		}
		for _, file := range append(p.TestGoFiles, p.XTestGoFiles...) {
			path := filepath.Join(p.Dir, file)
			info, err := os.Lstat(path)
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("test source is not a regular file: %s", path)
			}
			parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
			if err != nil {
				return nil, err
			}
			rel, err := filepath.Rel(root, path)
			if err != nil || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return nil, fmt.Errorf("test outside module: %s", path)
			}
			for _, decl := range parsed.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Recv != nil || !(strings.HasPrefix(fn.Name.Name, "Test") || strings.HasPrefix(fn.Name.Name, "Fuzz") || strings.HasPrefix(fn.Name.Name, "Example")) {
					continue
				}
				key := p.ImportPath + "::" + fn.Name.Name
				result[key] = append(result[key], filepath.ToSlash(rel))
			}
		}
	}
	return result, nil
}

func run() (int, error) {
	report := flag.String("report", "", "JUnit output path")
	file := flag.String("file", "", "test file for a single test")
	test := flag.String("test", "", "test name for a single test")
	imports := flag.Bool("imports", false, "parse Go imports from stdin")
	flag.Parse()
	if *imports {
		parsed, err := parser.ParseFile(token.NewFileSet(), "input.go", os.Stdin, parser.ImportsOnly)
		if err != nil {
			return 1, err
		}
		paths := []string{}
		for _, item := range parsed.Imports {
			path, err := strconv.Unquote(item.Path.Value)
			if err != nil {
				return 1, err
			}
			paths = append(paths, path)
		}
		return 0, json.NewEncoder(os.Stdout).Encode(struct {
			Package string   `json:"package"`
			Imports []string `json:"imports"`
		}{parsed.Name.Name, paths})
	}
	if *report == "" {
		return 1, errors.New("--report is required")
	}
	if (*file == "") != (*test == "") {
		return 1, errors.New("--file and --test must be supplied together")
	}
	root, err := os.Getwd()
	if err != nil {
		return 1, err
	}
	index, err := indexTests(root)
	if err != nil {
		return 1, err
	}
	tmp, err := os.CreateTemp("", "apos-go-junit-*.xml")
	if err != nil {
		return 1, err
	}
	name := tmp.Name()
	tmp.Close()
	defer os.Remove(name)
	args := []string{"--format", "standard-verbose", "--junitfile", name, "--", "./..."}
	if *file != "" {
		found := false
		for key, files := range index {
			if strings.HasSuffix(key, "::"+strings.SplitN(*test, "/", 2)[0]) && len(files) == 1 && files[0] == *file {
				found = true
			}
		}
		if !found {
			return 1, errors.New("test file and name do not identify a unique test")
		}
		parts := strings.Split(*test, "/")
		for i := range parts {
			parts[i] = "^" + regexp.QuoteMeta(parts[i]) + "$"
		}
		args = []string{"--format", "standard-verbose", "--junitfile", name, "--", "./" + filepath.ToSlash(filepath.Dir(*file)), "-run", strings.Join(parts, "/")}
	}
	cmd := exec.Command("gotestsum", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	err = cmd.Run()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return 1, err
		}
		code = exit.ExitCode()
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return 1, err
	}
	var doc junit
	if err := xml.Unmarshal(data, &doc); err != nil {
		return 1, err
	}
	selected := 0
	for i := range doc.Suites {
		kept := make([]testcase, 0, len(doc.Suites[i].Cases))
		for j := range doc.Suites[i].Cases {
			tc := &doc.Suites[i].Cases[j]
			testName := attr(tc.Attrs, "name")
			top := strings.SplitN(testName, "/", 2)[0]
			key := attr(tc.Attrs, "classname") + "::" + top
			files := index[key]
			if len(files) != 1 {
				return 1, fmt.Errorf("cannot uniquely map %s to a test file (%d matches)", key, len(files))
			}
			tc.Attrs = setAttr(tc.Attrs, "classname", files[0])
			tc.Attrs = setAttr(tc.Attrs, "file", files[0])
			if *file == "" || (files[0] == *file && testName == *test) {
				kept = append(kept, *tc)
				selected++
			}
		}
		doc.Suites[i].Cases = kept
	}
	if *file != "" && selected != 1 {
		return 1, fmt.Errorf("single test matched %d results", selected)
	}
	encoded, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		return 1, err
	}
	if err := os.WriteFile(*report, append([]byte(xml.Header), encoded...), 0600); err != nil {
		return 1, err
	}
	return code, nil
}

func main() {
	code, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "apos go-junit:", err)
	}
	if code != 0 {
		os.Exit(code)
	}
}
