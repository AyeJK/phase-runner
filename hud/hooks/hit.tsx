// A card, as something to click: a clear region laid over it. A Box can't be
// pressed and a Button can't hold a card's heading and bar, so this is a
// Client, laid over the card by pane.tsx. The same approach as the Eidola
// mod's card-hit.
//
// It fills its region with rows of blank text: on the desktop a Client takes
// the pointer only where it draws something, and an empty box draws nothing.
// The region is as many rows and columns as the pane asks for, more than
// the card needs; the card clips it to its own edges.

import type { ClientModule } from 'claude-code';

/** `cols` × `rows`: the region, in cells. */
type Props = { cols: number; rows: number };
type State = { isListening: true };

const Hit: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements;
  if (!surface.state) {
    surface.onPointer((e) => {
      if (e.type === 'down' && (e.button === 'left' || e.button === undefined)) {
        surface.post({ press: true });
      }
    });
    surface.setState({ isListening: true });
  }
  const cols = Math.max(1, props.cols);
  const rows = Math.max(1, props.rows);
  const blank = ' '.repeat(cols);
  return (
    <Box width={cols} height={rows} flexDirection="column" overflow="hidden">
      {Array.from({ length: rows }, (_, i) => (
        <Box key={`r${i}`} width={cols} height={1} overflow="hidden">
          <Text>{blank}</Text>
        </Box>
      ))}
    </Box>
  );
};

export default Hit;
