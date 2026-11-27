const gateCommands = new Set(['package submit', 'integrate', 'outcome close']);

export function gateCommandCount(actions) {
  return (
    1 + actions.filter(action => gateCommands.has(action.slice(0, 2).join(' ')) || action[0] === 'integrate').length
  );
}
