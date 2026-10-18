// The label of a control on the desktop: one row, the whole of it the hit,
// pressed on the pointer going down. The rounded box around it (its border,
// fill and hover) is drawn by pane.tsx; this draws the words and lights them
// under the pointer. A plain Button is drawn as bare text there, too small to
// read as a control, so the desktop's controls are this instead. The same
// approach as the Eidola mod's pill.

import type { ClientModule } from 'claude-code';

/** `lead`: a glyph before the words (a chevron), at their size and centred on their row; `size`: the words' size, body when absent; `label`: the words; `fg`, `hoverFg`: their color at rest and under the pointer; `bold`, `underline`: how they are drawn (`hover`: underlined under the pointer only); `cols`: the region's width. */
type Props = {
  label: string;
  fg: string;
  hoverFg: string;
  bold: boolean;
  underline?: boolean | 'hover';
  size?: 'body' | 'heading';
  /** Drawn before the label, never underlined: a chevron. */
  lead?: string;
  cols: number;
};
type State = { isHovered: boolean };

const Pill: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements;
  let state = surface.state;
  if (!state) {
    state = { isHovered: false };
    surface.onPointer((e) => {
      if (e.type === 'enter' || e.type === 'leave') {
        surface.setState({ isHovered: e.type === 'enter' });
      } else if (e.type === 'down' && (e.button === 'left' || e.button === undefined)) {
        surface.post({ press: true });
      }
    });
    surface.setState(state);
  }
  return (
    <Box width={props.cols} height={1} flexDirection="row" alignItems="center" justifyContent={props.underline === undefined ? 'center' : 'flex-start'}>
      {props.lead !== undefined && (
        <Text color={state.isHovered ? props.hoverFg : props.fg} {...(props.size ? { size: props.size } : {})}>
          {`${props.lead} `}
        </Text>
      )}
      <Text color={state.isHovered ? props.hoverFg : props.fg} bold={props.bold} {...(props.size ? { size: props.size } : {})} underline={props.underline === true || (props.underline === 'hover' && state.isHovered)}>
        {props.label}
      </Text>
    </Box>
  );
};

export default Pill;
