"""
Config file discovery and parsing for test automation frameworks.

Discovers .env, config.json, yaml, properties, and XML files within a framework path.
Extracts environment variables, base URLs, framework-specific config, and detects conflicts.
Sensitive keys (passwords, tokens, secrets) are redacted automatically.
"""

import os
import re
import json
from typing import Dict, List, Any, Optional
from collections import defaultdict


SECRET_KEY_PATTERNS = {
    'password', 'secret', 'token', 'key', 'auth', 'credential',
    'pwd', 'private', 'api_key', 'client_secret', 'access_token',
    'bearer', 'apikey', 'clientsecret', 'privatekey',
}


def _is_secret_key(key: str) -> bool:
    """Check if a key name indicates sensitive data."""
    key_lower = key.lower()
    return any(
        pattern in key_lower
        for pattern in SECRET_KEY_PATTERNS
    ) or key_lower in {
        'api_key', 'client_secret', 'access_token', 'refresh_token',
        'db_password', 'admin_password', 'user_password',
    }


def _extract_url_from_string(value: str) -> Optional[str]:
    """Extract URL from a value if it looks like one."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith(('http://', 'https://', 'ws://', 'wss://')):
        return value.split()[0]
    return None


def _extract_env_name(value: str) -> Optional[str]:
    """Extract environment name if value is a known env name."""
    if not isinstance(value, str):
        return None
    env_lower = value.lower().strip()
    known_envs = {'dev', 'development', 'test', 'qa', 'staging', 'prod', 'production', 'local'}
    if env_lower in known_envs:
        return env_lower
    return None


def _parse_env_file(path: str) -> Dict[str, str]:
    """Parse a .env file (simple KEY=VALUE format)."""
    result = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip()
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]
                result[key] = value
    except Exception:
        pass
    return result


def _parse_json_file(path: str) -> Dict[str, Any]:
    """Parse a JSON config file."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        pass
    return {}


def _parse_yaml_file(path: str) -> Dict[str, Any]:
    """Parse a YAML file (simplified regex-based, no external dependencies)."""
    result = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.rstrip()
                if not line or line.strip().startswith('#'):
                    continue
                if ':' not in line:
                    continue
                if line.startswith(' '):
                    continue
                key, _, value = line.partition(':')
                key = key.strip()
                value = value.strip()
                if value:
                    result[key] = value
    except Exception:
        pass
    return result


def _parse_properties_file(path: str) -> Dict[str, str]:
    """Parse a Java .properties file."""
    result = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' not in line and ':' not in line:
                    continue
                if '=' in line:
                    key, _, value = line.partition('=')
                else:
                    key, _, value = line.partition(':')
                key = key.strip()
                value = value.strip()
                result[key] = value
    except Exception:
        pass
    return result


def _parse_playwright_ts(path: str) -> Dict[str, Any]:
    """Extract baseURL and other config from playwright.config.ts via regex."""
    result = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        # Look for baseURL: 'https://...' or baseURL: "https://..."
        base_url_match = re.search(r'baseURL:\s*["\']([^"\']+)["\']', content)
        if base_url_match:
            result['baseURL'] = base_url_match.group(1)
        # Look for headless: true/false
        headless_match = re.search(r'headless:\s*(true|false)', content, re.IGNORECASE)
        if headless_match:
            result['headless'] = headless_match.group(1).lower() == 'true'
    except Exception:
        pass
    return result


def _parse_cypress_config(path: str) -> Dict[str, Any]:
    """Extract baseUrl and other config from cypress.config.ts/js via regex."""
    result = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        # Look for baseUrl: 'https://...'
        base_url_match = re.search(r'baseUrl:\s*["\']([^"\']+)["\']', content)
        if base_url_match:
            result['baseUrl'] = base_url_match.group(1)
        # Look for viewportWidth/Height
        viewport_w = re.search(r'viewportWidth:\s*(\d+)', content)
        if viewport_w:
            result['viewportWidth'] = int(viewport_w.group(1))
    except Exception:
        pass
    return result


def _extract_from_testng_xml(path: str) -> Dict[str, Any]:
    """Extract parameter values from testng.xml."""
    result = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        # Look for <parameter name="key" value="val" />
        params = re.findall(r'<parameter\s+name=["\']([^"\']+)["\']\\s+value=["\']([^"\']+)["\']', content)
        for key, val in params:
            result[key] = val
    except Exception:
        pass
    return result


def _parse_requirements_txt(path: str) -> List[Dict[str, str]]:
    """Parse Python requirements.txt file."""
    dependencies = []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                # Remove version specifiers for cleaner output
                pkg_name = re.split(r'[><=!~]', line)[0].strip()
                if pkg_name and pkg_name not in {dep['name'] for dep in dependencies}:
                    dependencies.append({'name': pkg_name, 'source': 'requirements.txt'})
    except Exception:
        pass
    return dependencies


def _parse_package_json(path: str) -> List[Dict[str, str]]:
    """Parse Node package.json file."""
    dependencies = []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
        for pkg_name in deps:
            dependencies.append({'name': pkg_name, 'source': 'package.json'})
    except Exception:
        pass
    return dependencies


def _parse_pom_xml(path: str) -> List[Dict[str, str]]:
    """Parse Maven pom.xml file."""
    dependencies = []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        # Extract dependency artifact IDs via regex
        artifact_pattern = r'<artifactId>([^<]+)</artifactId>'
        for match in re.finditer(artifact_pattern, content):
            artifact = match.group(1)
            if artifact and artifact not in {dep['name'] for dep in dependencies}:
                dependencies.append({'name': artifact, 'source': 'pom.xml'})
    except Exception:
        pass
    return dependencies


def _parse_csproj(path: str) -> List[Dict[str, str]]:
    """Parse C# .csproj file."""
    dependencies = []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        # Extract PackageReference Include attributes
        pkg_pattern = r'<PackageReference\s+Include="([^"]+)"'
        for match in re.finditer(pkg_pattern, content):
            pkg = match.group(1)
            if pkg and pkg not in {dep['name'] for dep in dependencies}:
                dependencies.append({'name': pkg, 'source': '.csproj'})
    except Exception:
        pass
    return dependencies


def _parse_gradle_build(path: str) -> List[Dict[str, str]]:
    """Parse Gradle build.gradle file."""
    dependencies = []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        # Extract dependencies { ... } block
        dep_pattern = r"(?:testImplementation|implementation|api)\s+['\"]([^'\"]+)['\"]"
        for match in re.finditer(dep_pattern, content):
            dep = match.group(1)
            if dep and dep not in {d['name'] for d in dependencies}:
                dependencies.append({'name': dep, 'source': 'build.gradle'})
    except Exception:
        pass
    return dependencies


def discover_config_files(root: str, max_depth: int = 3) -> Dict[str, str]:
    """
    Discover config files in the root directory.
    Returns dict of {relative_path: absolute_path}.
    """
    found = {}
    env_patterns = {
        '.env', '.env.local', '.env.test', '.env.qa', '.env.staging', '.env.production',
        '.env.development', '.env.dev',
    }
    json_patterns = {
        'config.json', 'appsettings.json', 'playwright.config.json', 'jest.config.json',
        'package.json',
    }
    yaml_patterns = {
        'pytest.ini', 'pyproject.toml', 'playwright.config.yaml', 'playwright.config.yml',
        'cypress.config.yaml', 'cypress.config.yml',
    }
    properties_patterns = {
        'config.properties', 'test.properties', 'application.properties',
    }
    xml_patterns = {
        'testng.xml', 'app.config', 'web.config', 'pom.xml',
    }
    ts_js_patterns = {
        'playwright.config.ts', 'playwright.config.js',
        'cypress.config.ts', 'cypress.config.js',
        'jest.config.ts', 'jest.config.js',
    }
    build_patterns = {
        'build.gradle', 'build.gradle.kts',
    }
    dependency_patterns = {
        'requirements.txt', 'Gemfile', 'Pipfile',
    }

    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath[len(root):].count(os.sep)
        if depth > max_depth:
            dirnames.clear()
            continue

        # Skip common non-source directories
        skip_dirs = {
            'node_modules', '.git', '__pycache__', '.venv', 'venv',
            '.idea', '.vscode', 'build', 'dist', 'target',
        }
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]

        for filename in filenames:
            filepath = os.path.join(dirpath, filename)
            relpath = os.path.relpath(filepath, root)

            if filename in env_patterns:
                found[relpath] = filepath
            elif filename in json_patterns:
                found[relpath] = filepath
            elif filename in yaml_patterns:
                found[relpath] = filepath
            elif filename in properties_patterns:
                found[relpath] = filepath
            elif filename in xml_patterns:
                found[relpath] = filepath
            elif filename in ts_js_patterns:
                found[relpath] = filepath
            elif filename in build_patterns:
                found[relpath] = filepath
            elif filename in dependency_patterns:
                found[relpath] = filepath
            elif filename.endswith('.csproj'):
                found[relpath] = filepath
            elif filename.endswith('.properties') and 'config' in filename.lower():
                found[relpath] = filepath
            elif filename.endswith(('.yaml', '.yml')) and any(
                kw in filename.lower() for kw in ['config', 'test', 'pytest', 'playwright', 'cypress']
            ):
                found[relpath] = filepath

    return found


def parse_project_configs(root: str) -> Dict[str, Any]:
    """
    Discover and parse all config/env/property files under root.
    Returns ConfigContext dict with all discovered values, ambiguities, and redactions.
    """
    if not os.path.isdir(root):
        return _empty_config_context([
            {
                'type': 'error',
                'field': 'root',
                'detail': f'Path does not exist or is not a directory: {root}',
            }
        ])

    discovered_files = discover_config_files(root)
    env_vars = {}
    base_urls = set()
    environments = set()
    timeouts = {}
    framework_config = {}
    all_keys_per_file = defaultdict(set)
    redacted_keys = set()
    dependencies = []

    # Parse each discovered file
    for rel_path, abs_path in discovered_files.items():
        try:
            if rel_path.endswith('.env'):
                parsed = _parse_env_file(abs_path)
                for k, v in parsed.items():
                    all_keys_per_file[rel_path].add(k)
                    if _is_secret_key(k):
                        redacted_keys.add(k)
                        env_vars[k] = '***REDACTED***'
                    else:
                        env_vars[k] = v
                        if url := _extract_url_from_string(v):
                            base_urls.add(url)
                        if env_name := _extract_env_name(v):
                            environments.add(env_name)

            elif rel_path.endswith('.json'):
                parsed = _parse_json_file(abs_path)
                _flatten_json_for_config(parsed, '', env_vars, all_keys_per_file, rel_path, base_urls, environments)

            elif rel_path.endswith(('.yaml', '.yml')):
                parsed = _parse_yaml_file(abs_path)
                _extract_framework_yaml(parsed, rel_path, framework_config, base_urls)

            elif rel_path.endswith('.properties'):
                parsed = _parse_properties_file(abs_path)
                for k, v in parsed.items():
                    all_keys_per_file[rel_path].add(k)
                    if _is_secret_key(k):
                        redacted_keys.add(k)
                        env_vars[k] = '***REDACTED***'
                    else:
                        env_vars[k] = v
                        if url := _extract_url_from_string(v):
                            base_urls.add(url)

            elif 'playwright' in rel_path and rel_path.endswith(('.ts', '.js')):
                parsed = _parse_playwright_ts(abs_path)
                if parsed:
                    framework_config.setdefault('playwright', {})['use'] = parsed
                    if 'baseURL' in parsed:
                        base_urls.add(parsed['baseURL'])

            elif 'cypress' in rel_path and rel_path.endswith(('.ts', '.js')):
                parsed = _parse_cypress_config(abs_path)
                if parsed:
                    framework_config.setdefault('cypress', {})['use'] = parsed
                    if 'baseUrl' in parsed:
                        base_urls.add(parsed['baseUrl'])

            elif rel_path.endswith('testng.xml'):
                parsed = _extract_from_testng_xml(abs_path)
                if parsed:
                    framework_config.setdefault('testng', {})['parameters'] = parsed
                    for k, v in parsed.items():
                        if url := _extract_url_from_string(v):
                            base_urls.add(url)

        except Exception:
            pass

    # Parse dependencies from discovered files
    for rel_path, abs_path in discovered_files.items():
        try:
            if rel_path.endswith('requirements.txt'):
                dependencies.extend(_parse_requirements_txt(abs_path))
            elif rel_path.endswith('package.json'):
                dependencies.extend(_parse_package_json(abs_path))
            elif rel_path.endswith('pom.xml') and 'pom' in rel_path.lower():
                dependencies.extend(_parse_pom_xml(abs_path))
            elif rel_path.endswith('.csproj'):
                dependencies.extend(_parse_csproj(abs_path))
            elif rel_path.endswith('build.gradle') or rel_path.endswith('build.gradle.kts'):
                dependencies.extend(_parse_gradle_build(abs_path))
        except Exception:
            pass

    # Deduplicate dependencies by name
    seen_deps = set()
    unique_dependencies = []
    for dep in dependencies:
        if dep['name'] not in seen_deps:
            seen_deps.add(dep['name'])
            unique_dependencies.append(dep)

    # Detect ambiguities
    ambiguities = _detect_ambiguities(env_vars, base_urls, environments, discovered_files)

    return {
        'discovered_files': sorted(list(discovered_files.keys())),
        'env_vars': dict(sorted(env_vars.items())),
        'base_urls': sorted(list(base_urls)),
        'environments': sorted(list(environments)),
        'timeouts': timeouts if timeouts else {},
        'framework_config': framework_config,
        'dependencies': sorted(unique_dependencies, key=lambda x: x['name']),
        'ambiguities': ambiguities,
        'redacted_keys': sorted(list(redacted_keys)),
    }


def _flatten_json_for_config(
    obj: Any, prefix: str, env_vars: Dict, all_keys: Dict, file_path: str,
    base_urls: set, environments: set, max_depth: int = 3
) -> None:
    """Flatten nested JSON objects to extract top-level config values."""
    if max_depth <= 0 or not isinstance(obj, dict):
        return
    for key, val in obj.items():
        full_key = f'{prefix}.{key}' if prefix else key
        if isinstance(val, dict):
            _flatten_json_for_config(val, full_key, env_vars, all_keys, file_path, base_urls, environments, max_depth - 1)
        elif isinstance(val, (str, int, float, bool)):
            all_keys[file_path].add(key)
            val_str = str(val)
            if _is_secret_key(key):
                env_vars[key] = '***REDACTED***'
            else:
                env_vars[key] = val_str
                if url := _extract_url_from_string(val_str):
                    base_urls.add(url)
                if env_name := _extract_env_name(val_str):
                    environments.add(env_name)


def _extract_framework_yaml(
    parsed: Dict, rel_path: str, framework_config: Dict, base_urls: set
) -> None:
    """Extract framework-specific config from YAML."""
    if 'pytest' in rel_path:
        if 'addopts' in parsed:
            framework_config.setdefault('pytest', {})['addopts'] = parsed['addopts']
    elif 'playwright' in rel_path:
        if 'baseURL' in parsed:
            base_urls.add(parsed['baseURL'])
            framework_config.setdefault('playwright', {})['baseURL'] = parsed['baseURL']
    elif 'cypress' in rel_path:
        if 'baseUrl' in parsed:
            base_urls.add(parsed['baseUrl'])
            framework_config.setdefault('cypress', {})['baseUrl'] = parsed['baseUrl']


def _detect_ambiguities(
    env_vars: Dict[str, str], base_urls: set, environments: set, discovered_files: Dict
) -> List[Dict[str, Any]]:
    """Detect conflicts, missing required values, and unresolved placeholders."""
    ambiguities = []

    # Check for placeholder values
    placeholder_pattern = r'(\$\{[^}]+\}|<[^>]+>|\[\[\w+\]\])'
    for key, val in env_vars.items():
        if val and val != '***REDACTED***' and re.search(placeholder_pattern, val):
            ambiguities.append({
                'type': 'unresolved_placeholder',
                'field': key,
                'detail': f'Value contains placeholder that was not expanded: {val}',
                'values': [val],
            })

    # Check if BASE_URL is present
    has_base_url = (
        'BASE_URL' in env_vars or
        'baseURL' in env_vars or
        'base_url' in env_vars or
        bool(base_urls)
    )
    if not has_base_url:
        ambiguities.append({
            'type': 'missing',
            'field': 'BASE_URL',
            'detail': 'No base URL found in configuration files. Test scripts will need an explicit URL.',
        })

    # Check if multiple .env files exist (potential ambiguity)
    env_files = [f for f in discovered_files.keys() if f.endswith('.env') or '.env.' in f]
    if len(env_files) > 1:
        ambiguities.append({
            'type': 'ambiguous',
            'field': 'environment',
            'detail': f'Found {len(env_files)} .env files: {", ".join(env_files)}. It is unclear which environment is active.',
            'values': env_files,
        })

    return ambiguities


def _empty_config_context(ambiguities: Optional[List] = None) -> Dict[str, Any]:
    """Return an empty ConfigContext with optional ambiguities."""
    return {
        'discovered_files': [],
        'env_vars': {},
        'base_urls': [],
        'environments': [],
        'timeouts': {},
        'framework_config': {},
        'dependencies': [],
        'ambiguities': ambiguities or [],
        'redacted_keys': [],
    }
