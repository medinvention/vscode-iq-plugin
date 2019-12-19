/*
 * Copyright (c) 2019-present Sonatype, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as path from "path";
import * as fs from "fs";
import * as _ from "lodash";

import { exec } from "../../utils/exec";
import { PackageDependenciesHelper } from "../PackageDependenciesHelper";
import { NpmPackage } from "./NpmPackage";
import {
  NPM_SHRINKWRAP_JSON,
  YARN_LOCK,
  PACKAGE_LOCK_JSON
} from "./NpmScanType";

const NPM_SHRINKWRAP_COMMAND = "npm shrinkwrap";
const YARN_LIST_COMMAND = "yarn list";
const NPM_LIST_COMMAND = "npm list";

export class NpmUtils {
  public async getDependencyArray(
    manifestType: string
  ): Promise<Array<NpmPackage>> {
    try {
      if (manifestType === YARN_LOCK) {
        let { stdout, stderr } = await exec(YARN_LIST_COMMAND, {
          cwd: PackageDependenciesHelper.getWorkspaceRoot()
        });

        if (stdout != "" && stderr == "") {
          return Promise.resolve(this.parseYarnList(stdout));
        } else {
          return Promise.reject(
            `Error running ${YARN_LIST_COMMAND}, err: ${stderr}`
          );
        }
      }
      if (manifestType === NPM_SHRINKWRAP_JSON) {
        let { stdout, stderr } = await exec(NPM_SHRINKWRAP_COMMAND, {
          cwd: PackageDependenciesHelper.getWorkspaceRoot()
        });
        let npmShrinkWrapFile = NPM_SHRINKWRAP_JSON;
        let shrinkWrapSucceeded =
          stdout || stderr.search(npmShrinkWrapFile) > -1;
        if (!shrinkWrapSucceeded) {
          return Promise.reject(`Unable to run ${NPM_SHRINKWRAP_COMMAND}`);
        }
        let obj = JSON.parse(
          fs.readFileSync(
            path.join(
              PackageDependenciesHelper.getWorkspaceRoot(),
              NPM_SHRINKWRAP_JSON
            ),
            "utf8"
          )
        );
        //get the top level ones
        let npmPackageContents = fs.readFileSync(
          path.join(
            PackageDependenciesHelper.getWorkspaceRoot(),
            "package.json"
          ),
          "utf8"
        );
        let objTopLevel = JSON.parse(npmPackageContents);
        console.log("objTopLevel", objTopLevel);
        let dependencies = objTopLevel.dependencies;
        let devDependencies = objTopLevel.devDependencies;
        let flatDependencies = this.flattenAndUniqDependencies(
          obj,
          objTopLevel
        );
        return Promise.resolve(flatDependencies);
      }
      if (manifestType === PACKAGE_LOCK_JSON) {
        let { stdout, stderr } = await exec(NPM_LIST_COMMAND, {
          cwd: PackageDependenciesHelper.getWorkspaceRoot()
        });

        if (stdout != "" && stderr == "") {
          return Promise.resolve(this.parseNpmList(stdout));
        } else {
          return Promise.reject(
            `Error running ${NPM_LIST_COMMAND}, err: ${stderr}`
          );
        }
      } else {
        return Promise.reject(
          `No valid command supplied, have you implemented it? Manifest type supplied: ${manifestType}`
        );
      }
    } catch (e) {
      return Promise.reject(
        `${manifestType} read failed, try running it manually to see what went wrong: ${e.stderr}`
      );
    }
  }

  private parseYarnList(output: string) {
    let dependencyList: NpmPackage[] = [];
    let results = output.split("\n");

    results.forEach((dep, index) => {
      if (index == 0) {
        console.debug("Skipping line");
      } else {
        let splitParts = dep.trim().split(" ");
        if (!this.isRegularVersion(splitParts[splitParts.length - 1])) {
          console.debug("Skipping since version range");
        } else {
          try {
            dependencyList.push(this.setAndReturnNpmPackage(splitParts));
          } catch (e) {
            console.debug(e.stderr);
          }
        }
      }
    });

    dependencyList = _.uniqBy(dependencyList, x => {
      return x.toPurl();
    });

    return this.sortDependencyList(dependencyList);
  }

  private setAndReturnNpmPackage(splitParts: string[]): NpmPackage {
    let newName = this.removeScopeSymbolFromName(
      splitParts[splitParts.length - 1]
    );
    let newSplit = newName.split("@");
    const name = newSplit[0];
    const version = newSplit[1];
    if (name != "" && version != undefined) {
      return new NpmPackage(name.replace("%40", "@"), version, "");
    } else {
      throw new Error(`No valid information, skipping dependency: ${newName}`);
    }
  }

  private sortDependencyList(list: NpmPackage[]): NpmPackage[] {
    return list.sort((a, b) => {
      if (a.Name > b.Name) {
        return 1;
      }
      if (a.Name < b.Name) {
        return -1;
      }
      return 0;
    });
  }

  private isRegularVersion(version: string): boolean {
    if (version.includes("^")) {
      return false;
    }
    if (version.includes(">=")) {
      return false;
    }
    if (version.includes("<=")) {
      return false;
    }
    if (version.includes("~")) {
      return false;
    }
    if (version.includes("<")) {
      return false;
    }
    if (version.includes(">")) {
      return false;
    }
    return true;
  }

  private parseNpmList(output: string) {
    let dependencyList: NpmPackage[] = [];
    let results = output.split("\n");

    results.forEach((dep, index) => {
      if (index == 0) {
        console.debug("Skipping first line");
      } else {
        let splitParts = dep.trim().split(" ");

        if (splitParts[splitParts.length - 1] === "deduped") {
          console.debug("Skipping");
        } else {
          try {
            dependencyList.push(this.setAndReturnNpmPackage(splitParts));
          } catch (e) {
            console.debug(e);
          }
        }
      }
    });

    dependencyList = _.uniqBy(dependencyList, x => {
      return x.toPurl();
    });

    return this.sortDependencyList(dependencyList);
  }

  private removeScopeSymbolFromName(name: string): string {
    if (name.substr(0, 1) === "@") {
      return "%40" + name.substr(1, name.length);
    } else {
      return name;
    }
  }

  private flattenAndUniqDependencies(
    npmShrinkwrapContents: any,
    npmPackageContents: any
  ): Array<NpmPackage> {
    console.debug(
      "flattenAndUniqDependencies",
      npmShrinkwrapContents,
      npmPackageContents
    );
    //first level in npm-shrinkwrap is our project package, we go a level deeper not to include it in the results
    // TODO: handle case where npmShrinkwrapContents does not have a 'dependencies' element defined (eg: simple projects)
    let npmShrinkwrapContentsDependencies: Array<NpmPackage> =
      npmShrinkwrapContents.dependencies;
    if (npmShrinkwrapContentsDependencies === undefined) {
      return new Array();
    }
    let flatDependencies = this.flattenDependencies(
      this.extractInfo(npmShrinkwrapContentsDependencies)
    );
    let newflatDependencies = _.uniqBy(flatDependencies, function(x) {
      return x.Name;
    });

    //I have the array here of all dependencies
    //I have an array of dependencies
    //I have an array of devdependencies
    let dependenciesTopLevel: Array<NpmPackage> = this.extractPackageJsonInfo(
      npmPackageContents.dependencies
    );
    if (dependenciesTopLevel !== undefined) {
      //do nothing
      for (let index = 0; index < dependenciesTopLevel.length; index++) {
        const elementTopLevel: NpmPackage = dependenciesTopLevel[index];
        console.log(elementTopLevel);
        //update flatDependencies
        for (
          let indexflatDependencies = 0;
          indexflatDependencies < flatDependencies.length;
          indexflatDependencies++
        ) {
          const elementflatDependencies =
            flatDependencies[indexflatDependencies];
          elementflatDependencies.IsTransitive = true;

          if (elementflatDependencies.Name === elementTopLevel.Name) {
            //update the is transitive to false as this is a top level dependency
            elementflatDependencies.IsTransitive = false;
            //also dependencyType is toplevel
            elementflatDependencies.DependencyType = "dependency";
            break;
          }
        }
      }
    }
    let devDependencies: Array<NpmPackage> = this.extractPackageJsonInfo(
      npmPackageContents.devDependencies
    );
    if (devDependencies !== undefined) {
      //do nothing
      for (
        let indexdevDependencies = 0;
        indexdevDependencies < devDependencies.length;
        indexdevDependencies++
      ) {
        const element = devDependencies[indexdevDependencies];
        console.log(element);
        for (
          let indexflatDependencies = 0;
          indexflatDependencies < flatDependencies.length;
          indexflatDependencies++
        ) {
          const elementflatDependencies =
            flatDependencies[indexflatDependencies];
          elementflatDependencies.IsTransitive = true;
          if (elementflatDependencies.Name === element.Name) {
            elementflatDependencies.DependencyType = "devDependency";
            elementflatDependencies.IsTransitive = false;
            break;
          }
        }
      }
    }

    console.log("newflatDependencies", newflatDependencies);
    return flatDependencies;
  }

  private flattenDependencies(dependencies: any): Array<NpmPackage> {
    let result = new Array<NpmPackage>();
    for (let dependency of dependencies) {
      result.push(dependency);
      if (dependency.dependencies) {
        result = result.concat(
          this.flattenDependencies(this.extractInfo(dependency.dependencies))
        );
      }
    }
    return result;
  }

  //extracts array with name, version, dependencies from a dictionary
  private extractInfo(array: any): Array<NpmPackage> {
    let isTransitive = true;
    let hash = "";
    return Object.keys(array).map(
      k =>
        new NpmPackage(
          k,
          array[k].version,
          hash,
          isTransitive,
          array[k].dev ? "devDependency" : "dependency"
        )
    );
  }

  //extracts array with name, version, dependencies from a dictionary
  private extractPackageJsonInfo(array: any): Array<NpmPackage> {
    let isTransitive = false;
    let scope = "";
    let hash = "";
    return Object.keys(array).map(
      k => new NpmPackage(k, array[k].split(":")[1], hash, isTransitive)
    );
  }
}
