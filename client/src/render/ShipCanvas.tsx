// react mount for the canvas stage; all rendering runs outside react (step 1.6)
import { useEffect, useRef, type RefObject } from "react";
import type { GameTableGame, ItemKind, PlacedItem } from "shared";
import type { Connection } from "../net/connection";
import { Stage } from "./stage";

export function ShipCanvas(props: {
  conn: Connection;
  stageRef: RefObject<Stage | null>;
  // shuttle boarded/docked — App feeds this to the hud's flight texts (notes/003)
  onFlyingChange: (flying: boolean) => void;
  // race run started/ended + gates passed — App feeds the race hud (shuttle race feature)
  onRacingChange: (racing: boolean) => void;
  onRaceGate: (passed: number) => void;
  // blasters run started/ended — App feeds the blasters hud (shuttle blasters feature)
  onBlastingChange: (blasting: boolean) => void;
  // E pressed at a holotable — App joins that table's game lobby
  onGameTable: (game: GameTableGame) => void;
  // E pressed at the Space Link — App opens the overlay (space link feature)
  onSpaceLink: () => void;
  // a prop was picked (or unpicked) in build mode — App offers to clear it (notes/017)
  onDecorSelect: (item: PlacedItem | null) => void;
  // a placement just un-armed the kind — App's copy follows suit (notes/017)
  onDecorArmedChange: (kind: ItemKind | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // the stage owns the rAF loop and listeners; torn down when the view unmounts
    const stage = new Stage(
      canvasRef.current!,
      props.conn,
      props.onFlyingChange,
      {
        onRacingChange: props.onRacingChange,
        onRaceGate: props.onRaceGate,
        onBlastingChange: props.onBlastingChange,
        onGameTable: props.onGameTable,
        onSpaceLink: props.onSpaceLink,
      },
      props.onDecorSelect,
      props.onDecorArmedChange,
    );
    // exposed so the hud zoom buttons reach the stage camera (step 2.3)
    props.stageRef.current = stage;
    return () => {
      props.stageRef.current = null;
      stage.dispose();
    };
  }, [
    props.conn,
    props.stageRef,
    props.onFlyingChange,
    props.onRacingChange,
    props.onRaceGate,
    props.onBlastingChange,
    props.onGameTable,
    props.onSpaceLink,
    props.onDecorSelect,
    props.onDecorArmedChange,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
      }}
    />
  );
}
