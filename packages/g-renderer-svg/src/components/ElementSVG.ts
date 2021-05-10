import { Component } from '@antv/g-ecs';

export class ElementSVG extends Component {
  static tag = 'c-svg-element';

  /**
   * basic element, eg. <circle>|<ellipse>
   */
  $el: SVGElement | null;

  /**
   * group wrapper for basic element, eg. <group><circle /></group>.
   * if current element is <group>, same as `$el`
   */
  $groupEl: SVGElement | null;
}