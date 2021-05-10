import { Entity } from '@antv/g-ecs';
import { isNil } from '@antv/util';
import EventEmitter from 'eventemitter3';
import { Transform } from '../components/Transform';
import { SceneGraphNode } from '../components/SceneGraphNode';
import { Sortable } from '../components/Sortable';
import { inject, injectable } from 'inversify';
import { Geometry, Renderable } from '../components';
import { mat4, quat, vec3 } from 'gl-matrix';
import { DisplayObject } from '../DisplayObject';
import { selectOne, selectAll } from 'css-select';
import { SceneGraphAdapter } from './SceneGraphAdapter';
import { AABB } from '../shapes';

function sortByZIndex(e1: Entity, e2: Entity) {
  const sortable1 = e1.getComponent(Sortable);
  const sortable2 = e2.getComponent(Sortable);

  return sortable1.zIndex - sortable2.zIndex;
}

export enum SCENE_GRAPH_EVENT {
  AABBChanged = 'AABBChanged',
}

/**
 * update transform in scene graph
 *
 * @see https://community.khronos.org/t/scene-graphs/50542/7
 */
@injectable()
export class SceneGraphService extends EventEmitter {
  @inject(SceneGraphAdapter)
  private sceneGraphAdapter: SceneGraphAdapter;

  reset() {}

  querySelector(query: string, group: DisplayObject) {
    return selectOne(query, group, { adapter: this.sceneGraphAdapter });
  }

  querySelectorAll(query: string, group: DisplayObject) {
    return selectAll(query, group, { adapter: this.sceneGraphAdapter });
  }

  attach(entity: Entity, parentEntity: Entity, index?: number) {
    const hierarchy = entity.getComponent(SceneGraphNode);
    if (hierarchy && hierarchy.parent) {
      this.detach(entity);
    }

    hierarchy.parent = parentEntity;
    const parentSceneGraphNode = parentEntity.getComponent(SceneGraphNode);
    if (!isNil(index)) {
      parentSceneGraphNode.children.splice(index!, 0, entity);
    } else {
      parentSceneGraphNode.children.push(entity);
    }

    this.dirtifyAABB(hierarchy.parent);

    const transformParent = parentEntity.getComponent(Transform);

    if (transformParent) {
      this.matrixTransform(entity, mat4.invert(mat4.create(), transformParent.worldTransform));
    }
  }

  detach(entity: Entity) {
    const hierarchy = entity.getComponent(SceneGraphNode);
    if (hierarchy.parent) {
      const transform = entity.getComponent(Transform);
      this.applyTransform(entity, transform);

      const parentSceneGraphNode = hierarchy.parent?.getComponent(SceneGraphNode);
      if (parentSceneGraphNode) {
        const index = parentSceneGraphNode.children.indexOf(entity);
        if (index > -1) {
          parentSceneGraphNode.children.splice(index, 1);
        }
      }

      // inform parent mesh to update its aabb
      this.dirtifyAABB(hierarchy.parent);
      hierarchy.parent = null;
    }
  }

  detachChildren(parent: Entity) {
    this.getChildren(parent).forEach((entity) => {
      this.detach(entity);
    });
  }

  /**
   * do DFS in scenegraph
   */
  visit(entity: Entity, visitor: (e: Entity, ...args: any) => void | boolean, ...args: any) {
    if (visitor(entity, ...args)) {
      return;
    }
    const entities = this.getChildren(entity);
    for (const child of entities) {
      this.visit(child, visitor, ...args);
    }
  }

  /**
   * execute topological sort on current scene graph, account for z-index on `Sortable` component
   */
  sort(entity: Entity, force = false) {
    const sortable = entity.getComponent(Sortable);

    if (sortable.dirty || force) {
      const sorted: Entity[] = [];
      this.flatten([entity], sorted);
      sortable.sorted = sorted;
      sortable.dirty = false;
    }

    return sortable.sorted;
  }

  private getChildren(parent: Entity): Entity[] {
    return parent.getComponent(SceneGraphNode).children;
  }

  private flatten(entities: Entity[], result: Entity[]) {
    if (entities.length) {
      entities.sort(sortByZIndex).forEach((entity) => {
        result.push(entity);
        const hierarchy = entity.getComponent(SceneGraphNode);
        this.flatten(hierarchy.children, result);
      });
    }
  }

  /**
   * apply matrix to local transform
   *
   * 对应 g 的 applyToMatrix
   * @see https://github.com/antvis/g/blob/master/packages/g-base/src/abstract/element.ts#L684-L689
   */
  matrixTransform = (() => {
    const transformed = mat4.create();
    return (entity: Entity, mat: mat4) => {
      const transform = entity.getComponent(Transform);
      mat4.multiply(transformed, this.getLocalTransform(entity), mat);
      mat4.getScaling(transform.localScale, transformed);
      mat4.getTranslation(transform.localPosition, transformed);
      mat4.getRotation(transform.localRotation, transformed);
      this.setLocalDirty(entity, transform);
    };
  })();

  applyTransform(entity: Entity, transform: Transform) {
    mat4.getScaling(transform.localScale, transform.worldTransform);
    mat4.getTranslation(transform.localPosition, transform.worldTransform);
    mat4.getRotation(transform.localRotation, transform.worldTransform);
    this.setDirty(entity, transform);
  }

  setOrigin(entity: Entity, origin: vec3 | number, y = 0, z = 0) {
    if (typeof origin === 'number') {
      origin = vec3.fromValues(origin, y, z);
    }
    const transform = entity.getComponent(Transform);

    const originVec = transform.origin;
    originVec[0] = origin[0];
    originVec[1] = origin[1];
    originVec[2] = origin[2] || 0;
    // this.setLocalDirty(entity, transform);
  }

  /**
   * rotate in world space
   */
  rotate = (() => {
    const parentInvertRotation = quat.create();
    return (entity: Entity, degrees: vec3 | number, y = 0, z = 0) => {
      if (typeof degrees === 'number') {
        degrees = vec3.fromValues(degrees, y, z);
      }

      const transform = entity.getComponent(Transform);
      const hierarchy = entity.getComponent(SceneGraphNode);
      if (hierarchy.parent === null) {
        this.rotateLocal(entity, degrees);
      } else {
        const rotation = quat.create();
        quat.fromEuler(rotation, degrees[0], degrees[1], degrees[2]);
        const rot = this.getRotation(entity);
        const parentRot = this.getRotation(hierarchy.parent);

        quat.copy(parentInvertRotation, parentRot);
        quat.invert(parentInvertRotation, parentInvertRotation);
        quat.multiply(parentInvertRotation, parentInvertRotation, rotation);
        quat.multiply(transform.localRotation, rotation, rot);
        quat.normalize(transform.localRotation, transform.localRotation);
        this.setLocalDirty(entity, transform);
      }
    };
  })();

  /**
   * rotate in local space
   * @see @see https://docs.microsoft.com/en-us/windows/win32/api/directxmath/nf-directxmath-xmquaternionrotationrollpitchyaw
   */
  rotateLocal = (() => {
    const rotation = quat.create();
    return (entity: Entity, degrees: vec3 | number, y = 0, z = 0) => {
      if (typeof degrees === 'number') {
        degrees = vec3.fromValues(degrees, y, z);
      }
      const transform = entity.getComponent(Transform);
      quat.fromEuler(rotation, degrees[0], degrees[1], degrees[2]);
      quat.mul(transform.localRotation, transform.localRotation, rotation);
      quat.normalize(transform.localRotation, transform.localRotation);
      this.setLocalDirty(entity, transform);
    };
  })();

  /**
   * set euler angles(degrees) in world space
   */
  setEulerAngles = (() => {
    const invParentRot = quat.create();

    return (entity: Entity, degrees: vec3 | number, y = 0, z = 0) => {
      if (typeof degrees === 'number') {
        degrees = vec3.fromValues(degrees, y, z);
      }

      const transform = entity.getComponent(Transform);
      const hierarchy = entity.getComponent(SceneGraphNode);

      if (hierarchy.parent === null) {
        this.setLocalEulerAngles(entity, degrees);
      } else {
        quat.fromEuler(transform.localRotation, degrees[0], degrees[1], degrees[2]);
        const parentRotation = this.getRotation(hierarchy.parent);
        quat.copy(invParentRot, quat.invert(quat.create(), parentRotation));
        quat.mul(transform.localRotation, transform.localRotation, invParentRot);

        this.setLocalDirty(entity, transform);
      }
    };
  })();

  /**
   * set euler angles(degrees) in local space
   */
  setLocalEulerAngles(entity: Entity, degrees: vec3 | number, y = 0, z = 0) {
    if (typeof degrees === 'number') {
      degrees = vec3.fromValues(degrees, y, z);
    }
    const transform = entity.getComponent(Transform);
    quat.fromEuler(transform.localRotation, degrees[0], degrees[1], degrees[2]);
    this.setLocalDirty(entity, transform);
  }

  /**
   * translate in local space
   *
   * @example
   * ```
   * translateLocal(x, y, z)
   * translateLocal(vec3(x, y, z))
   * ```
   */
  translateLocal = (() => {
    return (entity: Entity, translation: vec3 | number, y: number = 0, z: number = 0) => {
      if (typeof translation === 'number') {
        translation = vec3.fromValues(translation, y, z);
      }
      const transform = entity.getComponent(Transform);
      vec3.transformQuat(translation, translation, transform.localRotation);
      vec3.add(transform.localPosition, transform.localPosition, translation);

      this.setLocalDirty(entity, transform);
    };
  })();

  /**
   * move to position in world space
   *
   * 对应 g 原版的 move/moveTo
   * @see https://github.com/antvis/g/blob/master/packages/g-base/src/abstract/element.ts#L684-L689
   */
  setPosition = (() => {
    const parentInvertMatrix = mat4.create();

    return (entity: Entity, position: vec3 | number, y: number = 0, z: number = 0) => {
      if (typeof position === 'number') {
        position = vec3.fromValues(position, y, z);
      }
      const transform = entity.getComponent(Transform);

      // if (vec3.equals(transform.position, position)) {
      //   return;
      // }

      transform.position = position;

      const hierarchy = entity.getComponent(SceneGraphNode);
      if (hierarchy.parent === null) {
        this.setLocalPosition(entity, position);
      } else {
        const parentTransform = hierarchy.parent.getComponent(Transform);
        mat4.copy(parentInvertMatrix, parentTransform.worldTransform);
        mat4.invert(parentInvertMatrix, parentInvertMatrix);
        vec3.transformMat4(transform.localPosition, position, parentInvertMatrix);
        this.setLocalDirty(entity, transform);
      }
    };
  })();

  /**
   * move to position in local space
   */
  setLocalPosition(entity: Entity, position: vec3 | number, y: number = 0, z: number = 0) {
    if (typeof position === 'number') {
      position = vec3.fromValues(position, y, z);
    }
    const transform = entity.getComponent(Transform);

    // if (vec3.equals(transform.localPosition, position)) {
    //   return;
    // }

    vec3.copy(transform.localPosition, position);
    this.setLocalDirty(entity, transform);
  }

  /**
   * scale in local space
   */
  scaleLocal(entity: Entity, scaling: vec3 | number, y: number = 1, z: number = 1) {
    if (typeof scaling === 'number') {
      scaling = vec3.fromValues(scaling, y, z);
    }
    const transform = entity.getComponent(Transform);
    vec3.multiply(transform.localScale, transform.localScale, scaling);
    this.setLocalDirty(entity, transform);
  }

  setLocalScale(entity: Entity, scaling: vec3 | number, y: number = 1, z: number = 1) {
    if (typeof scaling === 'number') {
      scaling = vec3.fromValues(scaling, y, z);
    }
    const transform = entity.getComponent(Transform);

    // if (vec3.equals(transform.localScale, scaling)) {
    //   return;
    // }

    vec3.copy(transform.localScale, scaling);
    this.setLocalDirty(entity, transform);
  }

  /**
   * translate in world space
   *
   * @example
   * ```
   * translate(x, y, z)
   * translate(vec3(x, y, z))
   * ```
   *
   * 对应 g 原版的 translate 2D
   * @see https://github.com/antvis/g/blob/master/packages/g-base/src/abstract/element.ts#L665-L676
   */
  translate = (() => {
    const tr = vec3.create();

    return (entity: Entity, translation: vec3 | number, y: number = 0, z: number = 0) => {
      const transform = entity.getComponent(Transform);

      if (typeof translation === 'number') {
        translation = vec3.fromValues(translation, y, z);
      }
      vec3.add(tr, this.getPosition(entity), translation);

      this.setPosition(entity, tr);
      this.setDirty(entity, transform, true);
    };
  })();

  setLocalDirty(entity: Entity, transform: Transform, value = true) {
    if (value) {
      if (!transform.localDirtyFlag) {
        transform.localDirtyFlag = true;
        if (!transform.dirtyFlag) {
          this.setDirty(entity, transform);
        } else {
          this.dirtifyAABB(entity);
        }
      }
    } else {
      transform.localDirtyFlag = false;
    }
  }

  setDirty(entity: Entity, transform: Transform, value = true) {
    if (value) {
      if (!transform.dirtyFlag) {
        this.unfreezeParentToRoot(entity);
      }
      this.dirtifyWorldInternal(entity, transform);
    } else {
      transform.dirtyFlag = false;
    }
  }

  getPosition(entity: Entity) {
    const transform = entity.getComponent(Transform);
    return mat4.getTranslation(transform.position, this.getWorldTransform(entity, transform));
  }

  getRotation(entity: Entity) {
    const transform = entity.getComponent(Transform);
    return mat4.getRotation(transform.rotation, this.getWorldTransform(entity, transform));
  }

  getScale(entity: Entity) {
    const transform = entity.getComponent(Transform);
    return mat4.getScaling(transform.scaling, this.getWorldTransform(entity, transform));
  }

  getWorldTransform(entity: Entity, transform: Transform) {
    if (!transform.localDirtyFlag && !transform.dirtyFlag) {
      return transform.worldTransform;
    }

    const parentEntity = entity.getComponent(SceneGraphNode).parent;
    const parentTransform = parentEntity?.getComponent(Transform);

    if (parentEntity && parentTransform) {
      this.getWorldTransform(parentEntity, parentTransform);
    }

    this.updateTransform(entity, transform);

    return transform.worldTransform;
  }

  getLocalPosition(entity: Entity) {
    return entity.getComponent(Transform).localPosition;
  }

  getLocalRotation(entity: Entity) {
    return entity.getComponent(Transform).localRotation;
  }

  getLocalScale(entity: Entity) {
    return entity.getComponent(Transform).localScale;
  }

  getLocalTransform(entity: Entity) {
    const transform = entity.getComponent(Transform);
    if (transform.localDirtyFlag) {
      mat4.fromRotationTranslationScaleOrigin(
        transform.localTransform,
        transform.localRotation,
        transform.localPosition,
        transform.localScale,
        transform.origin
      );
      this.setLocalDirty(entity, transform, false);
    }
    return transform.localTransform;
  }

  updateRenderableAABB(entity: Entity): void {
    const sceneGraphNode = entity.getComponent(SceneGraphNode);
    const renderable = entity.getComponent(Renderable);
    const transform = entity.getComponent(Transform);
    const geometry = entity.getComponent(Geometry);

    if (!renderable.aabb) {
      renderable.aabb = new AABB();
    }
    // apply transform to geometry.aabb
    // @see https://stackoverflow.com/questions/6053522/how-to-recalculate-axis-aligned-bounding-box-after-translate-rotate
    renderable.aabb.setFromTransformedAABB(geometry.aabb, this.getWorldTransform(entity, transform));

    // add children's aabbs
    // if (sceneGraphNode.children && sceneGraphNode.children.length) {
    //   for (const child of sceneGraphNode.children) {
    //     const childAabb = child.getComponent(Renderable).aabb;
    //     if (childAabb) {
    //       renderable.aabb.add(childAabb);
    //     }
    //   }
    // }

    // inform parent
    // if (sceneGraphNode.parent) {
    //   this.updateRenderableAABB(sceneGraphNode.parent);
    // }

    this.emit(SCENE_GRAPH_EVENT.AABBChanged, entity);

    // need to update dirty rectangle
    renderable.dirty = true;
  }

  private unfreezeParentToRoot(entity: Entity) {
    let p: SceneGraphNode | undefined = entity.getComponent(SceneGraphNode);
    while (p) {
      p.frozen = false;
      p = p.parent?.getComponent(SceneGraphNode);
    }
  }

  private dirtifyWorldInternal(entity: Entity, transform: Transform) {
    if (!transform.dirtyFlag) {
      const hierarchy = entity.getComponent(SceneGraphNode);
      hierarchy.frozen = false;
      transform.dirtyFlag = true;
      hierarchy.children.forEach((childEntity) => {
        const childTransform = childEntity.getComponent(Transform);
        if (!childTransform.dirtyFlag) {
          this.dirtifyWorldInternal(childEntity, childTransform);
        }
      });
    }
    this.dirtifyAABB(entity);
  }

  /**
   * need to update AABB in renderable
   */
  private dirtifyAABB(entity: Entity) {
    const renderable = entity.getComponent(Renderable);
    if (renderable) {
      this.updateRenderableAABB(entity);
    }
  }

  private updateTransform(entity: Entity, transform: Transform) {
    if (transform.localDirtyFlag) {
      this.getLocalTransform(entity);
    }
    if (transform.dirtyFlag) {
      const parentEntity = entity.getComponent(SceneGraphNode).parent;
      const parentTransform = parentEntity?.getComponent(Transform);
      if (parentEntity === null || !parentTransform) {
        mat4.copy(transform.worldTransform, this.getLocalTransform(entity));
      } else {
        // TODO: should we support scale compensation?
        // @see https://github.com/playcanvas/engine/issues/1077#issuecomment-359765557
        mat4.multiply(transform.worldTransform, parentTransform.worldTransform, this.getLocalTransform(entity));
      }
      this.setDirty(entity, transform, false);
    }
  }
}